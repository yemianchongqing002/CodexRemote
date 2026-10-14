// Package chat reads Codex rollout files. It never writes to CODEX_HOME.
package chat

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxLine = 2 << 20
const maxText = 64 << 10
const maxMessages = 500
const maxThreadBytes = 2 << 20
const maxTotalBytes = 32 << 20

type Message struct {
	ID        string `json:"id"`
	Seq       uint64 `json:"seq"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	Phase     string `json:"phase,omitempty"`
	Timestamp string `json:"timestamp"`
}

// TurnSettings reports recorded execution settings, not unsent desktop choices.
type TurnSettings struct {
	Model     string `json:"model"`
	Effort    string `json:"effort,omitempty"`
	Timestamp string `json:"timestamp"`
}

type Thread struct {
	SidebarPosition  *int64        `json:"sidebarPosition,omitempty"`
	ProjectID        string        `json:"projectId,omitempty"`
	Pinned           bool          `json:"pinned,omitempty"`
	SectionID        string        `json:"sectionId,omitempty"`
	LastTurnSettings *TurnSettings `json:"lastTurnSettings,omitempty"`
	ActiveTurnID     string        `json:"activeTurnId,omitempty"`
	ID               string        `json:"id"`
	Title            string        `json:"title"`
	Source           string        `json:"source"`
	Project          string        `json:"project"`
	ProjectPath      string        `json:"projectPath,omitempty"`
	Updated          string        `json:"updated"`
	Status           string        `json:"status"`
	Archived         bool          `json:"archived"`
	Version          string        `json:"version"`
	Count            int           `json:"count"`
	Limited          bool          `json:"limited"`
}

type Page struct {
	Thread   Thread    `json:"thread"`
	Messages []Message `json:"messages"`
	Cursor   string    `json:"cursor"`
	Before   string    `json:"before,omitempty"`
	More     bool      `json:"more"`
	Reset    bool      `json:"reset"`
}

type fileState struct {
	info          os.FileInfo
	offset        int64
	lineStart     int64
	pending       []byte
	dropping      bool
	thread        Thread
	messages      []Message
	canonical     bool
	seen          map[string]bool
	seq, revision uint64
	generation    string
	bytes         int
}

func nonce() string {
	var b [8]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}

type Store struct {
	desktop        *desktopIndex
	sidebarHash    [32]byte
	sidebarWarning string
	mu             sync.Mutex
	home           string
	files          map[string]*fileState
	lastDiscover   time.Time
	revision       uint64
	epoch          string
	warning        string
}

func New(home string) (*Store, error) {
	p, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	p, err = filepath.EvalSymlinks(p)
	if err != nil {
		return nil, fmt.Errorf("Codex 数据目录不可用: %w", err)
	}
	return &Store{home: p, files: map[string]*fileState{}, epoch: nonce()}, nil
}

func (s *Store) Version() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fmt.Sprintf("%s:%d", s.epoch, s.revision)
}
func (s *Store) Warning() string { s.mu.Lock(); defer s.mu.Unlock(); return s.warning }

// Refresh performs bounded incremental reads; callers may invoke it only while a viewer is active.
func (s *Store) Refresh(force bool) { s.refresh(force, "") }

// RefreshThread incrementally reads only this known rollout, without directory discovery.
func (s *Store) RefreshThread(id string) {
	if id == "" {
		return
	}
	s.mu.Lock()
	known := false
	for _, f := range s.files {
		if f.thread.ID == id {
			known = true
			break
		}
	}
	discover := !known && (s.lastDiscover.IsZero() || time.Since(s.lastDiscover) > 15*time.Second)
	s.mu.Unlock()
	if discover {
		s.Refresh(false)
	}
	s.refresh(false, id)
}

func (s *Store) refresh(force bool, threadID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if threadID == "" && (force || time.Since(s.lastDiscover) > 15*time.Second) {
		s.lastDiscover = time.Now()
		found := map[string]bool{}
		for _, dir := range []string{"sessions", "archived_sessions"} {
			root := filepath.Join(s.home, dir)
			// Do not follow directory symlinks, including the sessions root.
			fi, e := os.Lstat(root)
			if e != nil || !fi.IsDir() {
				continue
			}
			_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				if d.IsDir() {
					return nil
				}
				if d.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(d.Name(), ".jsonl") {
					return nil
				}
				info, e := d.Info()
				if e != nil || !info.Mode().IsRegular() {
					return nil
				}
				found[path] = true
				if _, ok := s.files[path]; !ok {
					if len(s.files) >= 2000 {
						s.warning = "会话超过 2000 个，仅索引部分会话"
						return nil
					}
					s.files[path] = fresh(path, dir == "archived_sessions")
					s.revision++
				}
				return nil
			})
		}
		for p := range s.files {
			if !found[p] {
				delete(s.files, p)
				s.revision++
			}
		}
	}
	for path, f := range s.files {
		if threadID != "" && f.thread.ID != threadID {
			continue
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || resolved != path {
			continue
		}
		info, e := os.Lstat(path)
		if e != nil || !info.Mode().IsRegular() {
			continue
		}
		if f.info != nil && (!os.SameFile(f.info, info) || info.Size() < f.offset || (info.Size() == f.offset && !info.ModTime().Equal(f.info.ModTime()))) {
			f = fresh(path, f.thread.Archived)
			s.files[path] = f
			s.revision++
		}
		if info.Size() == f.offset {
			f.info = info
			continue
		}
		h, e := os.Open(path)
		if e != nil {
			continue
		}
		opened, e := h.Stat()
		if e != nil || !os.SameFile(info, opened) {
			h.Close()
			continue
		}
		_, e = h.Seek(f.offset, io.SeekStart)
		if e != nil {
			h.Close()
			continue
		}
		old := f.revision
		// Limit each pass to 16 MiB per file, never blocking forever on a growing log.
		r := bufio.NewReaderSize(io.LimitReader(h, 16<<20), 64<<10)
		for {
			part, err := r.ReadSlice('\n')
			f.offset += int64(len(part))
			if !f.dropping {
				if len(f.pending)+len(part) > maxLine {
					f.pending = nil
					f.dropping = true
					f.thread.Limited = true
				} else {
					f.pending = append(f.pending, part...)
				}
			}
			if len(part) > 0 && part[len(part)-1] == '\n' {
				if !f.dropping {
					f.consume(f.pending, f.lineStart)
				}
				f.pending = nil
				f.dropping = false
				f.lineStart = f.offset
			}
			if err != nil && err != bufio.ErrBufferFull {
				break
			}
		}
		h.Close()
		f.info = info
		if old != f.revision {
			s.revision++
		}
		s.trimBudget()
	}
	if threadID == "" {
		s.loadDesktopIndex()
	}
}

func (s *Store) trimBudget() {
	// Bound retained content across all sessions as well as within one session.
	total := 0
	for _, f := range s.files {
		total += f.bytes + len(f.pending)
	}
	if total > maxTotalBytes {
		fs := make([]*fileState, 0, len(s.files))
		for _, f := range s.files {
			fs = append(fs, f)
		}
		sort.Slice(fs, func(i, j int) bool { return fs[i].thread.Updated < fs[j].thread.Updated })
		for _, f := range fs {
			for total > maxTotalBytes && len(f.messages) > 0 {
				n := len(f.messages[0].Text)
				f.removeFirst()
				total -= n
				f.revision++
				s.revision++
			}
			if total > maxTotalBytes && len(f.pending) > 0 {
				total -= len(f.pending)
				f.pending = nil
				f.dropping = true
				f.thread.Limited = true
				f.revision++
				s.revision++
			}
		}
	}
}

func fresh(path string, archived bool) *fileState {
	h := sha256.Sum256([]byte(path))
	return &fileState{generation: nonce(), seen: map[string]bool{}, thread: Thread{ID: hex.EncodeToString(h[:12]), Title: "未命名聊天", Archived: archived, Status: "unknown"}}
}

func short(v string, n int) string {
	r := []rune(v)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return v
}
func str(m map[string]json.RawMessage, k string) string {
	var v string
	_ = json.Unmarshal(m[k], &v)
	return v
}

func textBlocks(raw json.RawMessage) string {
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := []string{}
	for _, b := range blocks {
		switch strings.ToLower(str(b, "type")) {
		case "image", "input_image", "image_url", "local_image", "localimage":
			address := str(b, "image_url")
			if address == "" {
				address = str(b, "url")
			}
			if address == "" {
				address = str(b, "path")
			}
			if address == "" {
				var nested struct {
					URL string `json:"url"`
				}
				_ = json.Unmarshal(b["image_url"], &nested)
				address = nested.URL
			}
			if address != "" && !strings.ContainsAny(address, "<>\r\n") && !strings.HasPrefix(address, "data:") {
				parts = append(parts, "![图片附件](<"+address+">)")
			} else {
				parts = append(parts, "[图片附件：日志中没有可读取的地址]")
			}
		case "text", "input_text", "output_text":
			if t := str(b, "text"); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n\n")
}

func (f *fileState) consume(line []byte, offset int64) {
	var rec struct {
		Timestamp string                     `json:"timestamp"`
		Type      string                     `json:"type"`
		Payload   map[string]json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil {
		return
	}
	p := rec.Payload
	switch rec.Type {
	case "turn_context":
		var settings TurnSettings
		settings.Model = str(p, "model")
		settings.Effort = str(p, "effort")
		settings.Timestamp = rec.Timestamp
		// Replace the whole observation so missing fields cannot retain old values.
		f.thread.LastTurnSettings = nil
		if settings.Model != "" {
			f.thread.LastTurnSettings = &settings
		}
		f.revision++
	case "session_meta":
		if id := str(p, "id"); id != "" && len(id) < 160 && !strings.ContainsAny(id, "/\\") {
			f.thread.ID = id
		}
		f.thread.Source = str(p, "originator")
		if f.thread.Source == "" {
			f.thread.Source = str(p, "source")
		}
		if cwd := str(p, "cwd"); cwd != "" {
			f.thread.ProjectPath = filepath.Clean(cwd)
			f.thread.Project = filepath.Base(f.thread.ProjectPath)
		}
		f.thread.Updated = rec.Timestamp
		f.revision++
	case "event_msg":
		switch str(p, "type") {
		case "task_started":
			f.thread.Status = "active"
			f.thread.ActiveTurnID = str(p, "turn_id")
			f.thread.Updated = rec.Timestamp
			f.revision++
		case "task_complete":
			f.thread.Status = "idle"
			f.thread.ActiveTurnID = ""
			f.thread.Updated = rec.Timestamp
			f.revision++
		case "task_aborted", "turn_aborted":
			f.thread.Status = "interrupted"
			f.thread.ActiveTurnID = ""
			f.thread.Updated = rec.Timestamp
			f.revision++
		case "item_completed":
			var i map[string]json.RawMessage
			if json.Unmarshal(p["item"], &i) != nil {
				return
			}
			role := ""
			switch str(i, "type") {
			case "UserMessage":
				role = "user"
			case "AgentMessage":
				role = "assistant"
			default:
				return
			}
			if !f.canonical {
				f.canonical = true
				kept := []Message{}
				for _, m := range f.messages {
					if m.Role == "user" && strings.HasPrefix(m.ID, "codex-remote-initial-") {
						kept = append(kept, m)
					}
				}
				f.messages = kept
				f.bytes = 0
				f.seen = map[string]bool{}
				for _, m := range kept {
					f.bytes += len(m.Text)
					f.seen[m.ID] = true
				}
				f.generation = nonce()
				f.revision++
			}
			f.add(str(i, "id"), role, textBlocks(i["content"]), str(i, "phase"), rec.Timestamp, offset)
		}
	case "response_item":
		if f.canonical || str(p, "type") != "message" {
			return
		}
		role := str(p, "role")
		if role != "user" && role != "assistant" {
			return
		}
		if phase := str(p, "phase"); phase == "analysis" {
			return
		}
		// Desktop injects environment/plugin scaffolding as user messages; do not show it.
		var meta struct {
			Kinds []string `json:"content_item_kinds"`
		}
		_ = json.Unmarshal(p["internal_chat_message_metadata_passthrough"], &meta)
		for _, k := range meta.Kinds {
			if strings.Contains(k, "environment") || strings.Contains(k, "plugins.recommendations") {
				return
			}
		}
		f.add(str(p, "id"), role, textBlocks(p["content"]), str(p, "phase"), rec.Timestamp, offset)
	}
}

func (f *fileState) add(id, role, text, phase, stamp string, offset int64) {
	if role == "user" {
		text = displayUserText(text)
	}
	if text == "" {
		return
	}
	if id == "" {
		id = "line-" + strconv.FormatInt(offset, 10)
	}
	if f.seen[id] {
		return
	}
	if len(text) > maxText {
		text = string([]rune(text[:maxText])) + "\n[长消息已截断]"
		f.thread.Limited = true
	}
	f.seq++
	f.seen[id] = true
	f.messages = append(f.messages, Message{id, f.seq, role, text, phase, stamp})
	f.bytes += len(text)
	if role == "user" && f.thread.Title == "未命名聊天" {
		f.thread.Title = short(strings.Join(strings.Fields(text), " "), 64)
	}
	f.thread.Updated = stamp
	f.revision++
	for len(f.messages) > maxMessages || f.bytes > maxThreadBytes {
		f.removeFirst()
	}
}

func (f *fileState) removeFirst() {
	m := f.messages[0]
	f.bytes -= len(m.Text)
	delete(f.seen, m.ID)
	f.messages[0] = Message{}
	f.messages = f.messages[1:]
	f.thread.Limited = true
}
func (f *fileState) summary() Thread {
	t := f.thread
	t.Count = len(f.messages)
	t.Version = fmt.Sprintf("%s:%d", f.generation, f.revision)
	return t
}

func (s *Store) Read(id, before, after string, limit int) (Page, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit < 1 || limit > 100 {
		limit = 50
	}
	var f *fileState
	for _, v := range s.files {
		if v.thread.ID == id {
			f = v
			break
		}
	}
	if f == nil {
		if s.desktop != nil {
			for _, meta := range s.desktop.Threads {
				if meta.ID == id {
					return Page{Thread: s.decorate(Thread{ID: id, Status: "unknown"}, meta), Messages: []Message{}}, true
				}
			}
		}
		return Page{}, false
	}
	page := Page{Thread: f.summary(), Messages: []Message{}}
	if s.desktop != nil {
		for _, meta := range s.desktop.Threads {
			if meta.ID == id {
				page.Thread = s.decorate(page.Thread, meta)
				break
			}
		}
	}
	start, end := 0, len(f.messages)
	decode := func(c string) (uint64, bool) {
		parts := strings.Split(c, ".")
		if len(parts) != 2 || parts[0] != f.generation {
			return 0, false
		}
		v, e := strconv.ParseUint(parts[1], 10, 64)
		return v, e == nil
	}
	encode := func(n uint64) string { return f.generation + "." + strconv.FormatUint(n, 10) }
	if before != "" {
		n, ok := decode(before)
		if !ok {
			page.Reset = true
		} else {
			end = sort.Search(len(f.messages), func(i int) bool { return f.messages[i].Seq >= n })
		}
	}
	if after != "" {
		n, ok := decode(after)
		if !ok || n > f.seq || (len(f.messages) > 0 && n+1 < f.messages[0].Seq) {
			page.Reset = true
		} else {
			start = sort.Search(len(f.messages), func(i int) bool { return f.messages[i].Seq > n })
			if end-start > limit {
				end = start + limit
				page.More = true
			}
		}
	}
	if after == "" || page.Reset {
		start = end - limit
		if start < 0 {
			start = 0
		}
	}
	page.Messages = append(page.Messages, f.messages[start:end]...)
	page.Cursor = encode(f.seq)
	if page.More && end > start {
		page.Cursor = encode(f.messages[end-1].Seq)
	}
	if start > 0 && end > start {
		page.Before = encode(f.messages[start].Seq)
	}
	return page, true
}

// QueueReady requires a fully read, unchanged regular rollout and a terminal event.
func (s *Store) QueueReady(id string) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for path, f := range s.files {
		if f.thread.ID == id {
			info, err := os.Lstat(path)
			ended := f.thread.Status == "idle" || f.thread.Status == "interrupted"
			ready := err == nil && f.info != nil && os.SameFile(info, f.info) && info.Size() == f.offset && len(f.pending) == 0 && !f.dropping && !f.thread.Archived && ended && f.thread.ActiveTurnID == ""
			return ready, f.summary().Version
		}
	}
	return false, ""
}
