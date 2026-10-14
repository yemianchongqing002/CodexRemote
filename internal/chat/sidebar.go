package chat

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Project is a saved Codex project, never a directory inferred from a rollout.
type Project struct {
	ThreadOrder []string `json:"threadOrder,omitempty"`
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Path        string   `json:"path"`
	Roots       []string `json:"roots"`
	Available   bool     `json:"available"`
}
type SidebarSection struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Sidebar struct {
	Sections []SidebarSection `json:"sections"`
	Threads  []Thread         `json:"threads"`
	Projects []Project        `json:"projects"`
	Version  string           `json:"version"`
	Warning  string           `json:"warning"`
}

func (s *Store) loadDesktopIndex() {
	idx, err := readDesktopIndex(s.home)
	warning := ""
	if err != nil {
		warning = "无法读取 Codex 项目与任务列表：" + err.Error()
	}
	raw, _ := json.Marshal(struct {
		Index   *desktopIndex
		Warning string
	}{idx, warning})
	hash := sha256.Sum256(raw)
	if hash != s.sidebarHash {
		s.sidebarHash = hash
		s.revision++
	}
	s.desktop = idx
	s.sidebarWarning = warning
}

func (s *Store) decorate(t Thread, meta desktopThread) Thread {
	// Match the desktop placeholder until the catalog has a title; the first
	// message is not a desktop-assigned name.
	t.Title = meta.Title
	if strings.TrimSpace(t.Title) == "" {
		t.Title = "新聊天"
	}
	t.Archived = meta.Archived
	t.ProjectID = meta.ProjectID
	t.Project = ""
	t.ProjectPath = meta.Cwd
	t.Pinned = meta.Pinned
	t.SectionID = meta.Section
	if meta.Position != int64(9223372036854775807) {
		position := meta.Position
		t.SidebarPosition = &position
	}
	for _, p := range s.desktop.Projects {
		if p.ID == meta.ProjectID {
			t.Project = p.Name
			break
		}
	}
	return t
}

// Sidebar returns only desktop catalog entries. Rollout-only/internal tasks do
// not become visible merely because their files still exist.
func (s *Store) Sidebar() Sidebar {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Sidebar{Threads: []Thread{}, Projects: []Project{}, Version: fmt.Sprintf("%s:%d", s.epoch, s.revision), Warning: s.sidebarWarning}
	if s.desktop == nil {
		return out
	}
	out.Projects = append(out.Projects, s.desktop.Projects...)
	out.Sections = append([]SidebarSection{}, s.desktop.Sections...)
	summaries := map[string]Thread{}
	for _, f := range s.files {
		summaries[f.thread.ID] = f.summary()
	}
	for _, meta := range s.desktop.Threads {
		t, ok := summaries[meta.ID]
		if !ok {
			t = Thread{ID: meta.ID, Status: "unknown", Updated: time.UnixMilli(meta.Recency).UTC().Format(time.RFC3339Nano)}
		}
		out.Threads = append(out.Threads, s.decorate(t, meta))
	}
	if s.warning != "" {
		out.Warning = s.warning
	}
	return out
}
