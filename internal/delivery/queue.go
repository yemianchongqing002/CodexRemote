package delivery

import (
	"codexremote/internal/desktop"
	"codexremote/internal/platform"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type starter interface {
	Start(context.Context, string, string, string) desktop.Result
}

type imageSender interface {
	SendImages(context.Context, string, string, string, []string) desktop.Result
	StartImages(context.Context, string, string, string, []string) desktop.Result
}

type settingsSender interface {
	StartWithSettings(context.Context, string, string, string, []string, *desktop.ModelSettings) desktop.Result
}

const MaxQueuedPerThread = 5

func queueTime(e Entry) time.Time {
	if !e.QueuedAt.IsZero() {
		return e.QueuedAt
	}
	return e.At
}

func queueLess(a, b Entry) bool {
	if queueTime(a).Equal(queueTime(b)) {
		return a.ID < b.ID
	}
	return queueTime(a).Before(queueTime(b))
}

func (s *Service) restoreQueue() error {
	if err := os.MkdirAll(s.queueDir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(s.queueDir)
	if err != nil || !info.IsDir() || !platform.PrivateMode(info) {
		return errors.New("排队目录必须是 0700 普通目录")
	}
	for id, e := range s.entries {
		path := filepath.Join(s.queueDir, id)
		if e.Status != "queued" {
			_ = os.Remove(path)
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || !platform.PrivateMode(info) || info.Size() > 16<<10 {
			return errors.New("排队正文不可读，发送保持禁用")
		}
		text, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if (len(text) == 0 && len(e.Images) == 0) || settingsDigest(e.ThreadID, string(text), e.Images, e.ModelSettings) != e.Digest {
			return errors.New("排队正文校验失败，发送保持禁用")
		}
		s.queued[id] = string(text)
	}
	return nil
}

// Body is kept in a separate private file, not in the metadata journal.
func (s *Service) enqueue(id, thread, text, digest string, images []string, settings *desktop.ModelSettings) (Entry, error) {
	if _, ok := s.sender.(starter); !ok {
		return Entry{}, errors.New("此发送器不支持排队")
	}
	if len(s.queued) >= 32 {
		return Entry{}, errors.New("排队数量已达上限")
	}
	count := 0
	for _, e := range s.entries {
		if e.ThreadID == thread && e.Mode == "queue" && (e.Status == "queued" || e.Status == "pending") {
			count++
		}
	}
	if count >= MaxQueuedPerThread {
		return Entry{}, errors.New("这个聊天最多排队 5 条消息，请等待投递或删除后再发送")
	}
	path := filepath.Join(s.queueDir, id)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return Entry{}, errors.New("无法保存排队正文")
	}
	_, err = f.WriteString(text)
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err == nil {
		err = platform.SyncDir(s.queueDir)
	}
	if err != nil {
		os.Remove(path)
		return Entry{}, errors.New("无法保存排队正文")
	}
	entry := Entry{ID: id, ThreadID: thread, Digest: digest, Mode: "queue", Status: "queued", Detail: "已排队，等待聊天结束；可关闭手机网页", At: time.Now().UTC()}
	entry.ModelSettings = settings
	entry.QueuedAt = entry.At
	entry.Images = append([]string(nil), images...)
	if err = s.persist(entry); err != nil {
		s.diskErr = err
		os.Remove(path)
		return Entry{}, errors.New("无法保存排队记录，消息未发送")
	}
	s.entries[id] = entry
	s.queued[id] = text
	s.wakeQueue()
	return entry, nil
}

// Only queued messages cause disk reads; this worker does not depend on the phone.
const queueCheckInterval = 500 * time.Millisecond

func (s *Service) wakeQueue() {
	select {
	case s.queueWake <- struct{}{}:
	default:
	}
}

func (s *Service) RunQueue(ctx context.Context, ready func(string) (bool, string)) {
	for {
		if len(s.Queued("")) == 0 {
			select {
			case <-ctx.Done():
				return
			case <-s.queueWake:
			}
		}
		if ctx.Err() != nil {
			return
		}
		s.checkQueue(ready)
		timer := time.NewTimer(queueCheckInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
func (s *Service) checkQueue(ready func(string) (bool, string)) {
	seen := map[string]bool{}
	for _, entry := range s.Queued("") {
		// Only the oldest waiting message may advance for each thread.
		if seen[entry.ThreadID] {
			continue
		}
		seen[entry.ThreadID] = true
		idle, version := ready(entry.ThreadID)
		s.mu.Lock()
		e := s.entries[entry.ID]
		if s.closed || s.diskErr != nil {
			s.mu.Unlock()
			return
		}
		if e.Status != "queued" {
			s.mu.Unlock()
			continue
		}
		consumed := false
		for _, previous := range s.entries {
			if previous.ThreadID == e.ThreadID && previous.CompletionVersion == version &&
				(previous.Status == "pending" || previous.Status == "accepted" || previous.Status == "unknown") {
				consumed = true
				break
			}
		}
		if !idle || version == "" || s.working[e.ThreadID] || consumed {
			delete(s.idleSeen, e.ID)
			s.mu.Unlock()
			continue
		}
		if s.idleSeen[e.ID] != version {
			s.idleSeen[e.ID] = version
			s.mu.Unlock()
			continue
		}
		if len(s.working) >= 4 {
			s.mu.Unlock()
			continue
		}
		e.Status = "pending"
		if e.QueuedAt.IsZero() {
			e.QueuedAt = e.At
		}
		e.CompletionVersion = version
		e.Detail = "聊天已结束，正在投递排队消息"
		e.At = time.Now().UTC()
		if err := s.persist(e); err != nil {
			s.diskErr = err
			s.mu.Unlock()
			return
		}
		s.entries[e.ID] = e
		text := s.queued[e.ID]
		delete(s.idleSeen, e.ID)
		s.dispatch(e, text, true)
		s.mu.Unlock()
	}
}
func (s *Service) dispatch(e Entry, text string, queued bool) {
	s.working[e.ThreadID] = true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		result := s.deliverWithRetry(&e, text, queued)
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.working, e.ThreadID)
		if queued && result.Status == "deferred" {
			e.Status = "queued"
			e.CompletionVersion = ""
			e.Detail = result.Detail
			e.At = time.Now().UTC()
			if err := s.persist(e); err != nil {
				s.diskErr = err
			}
			s.entries[e.ID] = e
			s.queued[e.ID] = text
			s.wakeQueue()
			delete(s.idleSeen, e.ID)
			return
		}
		e.NextRetryAt = time.Time{}
		e.Status = result.Status
		e.Detail = result.Detail
		e.TurnID = result.TurnID
		e.At = time.Now().UTC()
		if e.Status != "accepted" && e.Status != "failed" && e.Status != "unknown" {
			e.Status = "unknown"
			e.Detail = "未收到有效的桌面回执，请核对聊天"
		}
		if err := s.persist(e); err != nil {
			s.diskErr = err
			e.Status = "unknown"
			e.Detail = "回执记录失败，请先核对目标聊天"
		}
		s.entries[e.ID] = e
		if e.Mode == "queue" {
			delete(s.queued, e.ID)
			_ = os.Remove(filepath.Join(s.queueDir, e.ID))
		}
	}()
}
func (s *Service) Queued(thread string) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Entry{}
	for _, e := range s.entries {
		if e.Mode == "queue" && (thread == "" || e.ThreadID == thread) && e.Status == "queued" {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return queueLess(out[i], out[j]) })
	return out
}
func (s *Service) Cancel(id string) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	if !ok {
		return Entry{}, errors.New("找不到排队记录")
	}
	if e.Status == "cancelled" {
		return e, nil
	}
	if e.Status != "queued" {
		return e, errors.New("消息已开始投递，无法取消，请核对聊天")
	}
	if s.closed || s.diskErr != nil {
		return Entry{}, errors.New("发送记录不可写")
	}
	e.Status = "cancelled"
	e.Detail = "已取消排队，消息未发送"
	e.At = time.Now().UTC()
	if err := s.persist(e); err != nil {
		s.diskErr = err
		return Entry{}, errors.New("无法保存取消记录，排队调度已暂停")
	}
	s.entries[id] = e
	delete(s.queued, id)
	delete(s.idleSeen, id)
	_ = os.Remove(filepath.Join(s.queueDir, id))
	return e, nil
}

// QueueView exposes the temporary body only to the authenticated queue endpoint.
// Entry and the durable metadata journal never contain plaintext.
type QueueView struct {
	Entry
	Text string `json:"text,omitempty"`
}

func (s *Service) QueueStatus(thread string) []QueueView {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []QueueView{}
	active := map[string]bool{}
	latest := map[string]Entry{}
	for _, e := range s.entries {
		if e.Mode != "queue" || (thread != "" && thread != e.ThreadID) {
			continue
		}
		if e.Status == "queued" || e.Status == "pending" {
			active[e.ThreadID] = true
			out = append(out, QueueView{e, s.queued[e.ID]})
			continue
		}
		if old, ok := latest[e.ThreadID]; !ok || e.At.After(old.At) {
			latest[e.ThreadID] = e
		}
	}
	for thread, e := range latest {
		if !active[thread] {
			out = append(out, QueueView{Entry: e})
		}
	}
	sort.Slice(out, func(i, j int) bool { return queueLess(out[i].Entry, out[j].Entry) })
	return out
}

// Promote atomically takes the same queued request out of automatic scheduling.
// Retries of this action return its existing receipt, never dispatch a second time.
func (s *Service) Promote(id string) (Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	if !ok || e.Mode != "queue" {
		return Entry{}, errors.New("找不到排队消息")
	}
	if e.Status == "cancelled" {
		return e, errors.New("这条消息已删除")
	}
	if e.Status != "queued" {
		return e, nil
	}
	if s.closed || s.diskErr != nil {
		return Entry{}, errors.New("发送记录不可写")
	}
	if s.working[e.ThreadID] || len(s.working) >= 4 {
		return Entry{}, ErrBusy
	}
	text, ok := s.queued[id]
	if !ok {
		return Entry{}, errors.New("排队正文不可用")
	}
	e.Status = "pending"
	e.Detail = "正在立即引导"
	if e.ModelSettings != nil {
		e.Detail = "正在引导当前轮，沿用当前轮模型"
	}
	e.At = time.Now().UTC()
	if err := s.persist(e); err != nil {
		s.diskErr = err
		return Entry{}, errors.New("无法保存引导记录，消息未发送")
	}
	s.entries[id] = e
	delete(s.idleSeen, id)
	s.dispatch(e, text, false)
	return e, nil
}

func (s *Service) attemptDelivery(ctx context.Context, e Entry, text string, queued bool) desktop.Result {
	var result desktop.Result
	if e.ModelSettings != nil && queued {
		s.mu.Lock()
		input, paths, err := s.attachmentInput(text, e.Images)
		s.mu.Unlock()
		sender, ok := s.sender.(settingsSender)
		if err != nil {
			result = desktop.Result{Status: "failed", Detail: err.Error()}
		} else if !ok || !queued {
			result = desktop.Result{Status: "failed", Detail: "模型设置需要下一轮发送"}
		} else {
			result = sender.StartWithSettings(ctx, e.ThreadID, e.ID, input, paths, e.ModelSettings)
		}
	} else if len(e.Images) > 0 {
		s.mu.Lock()
		input, paths, err := s.attachmentInput(text, e.Images)
		s.mu.Unlock()
		sender, ok := s.sender.(imageSender)
		if err != nil {
			result = desktop.Result{Status: "failed", Detail: err.Error()}
		} else if !ok {
			result = desktop.Result{Status: "failed", Detail: "此发送器不支持图片"}
		} else if queued {
			result = sender.StartImages(ctx, e.ThreadID, e.ID, input, paths)
		} else {
			result = sender.SendImages(ctx, e.ThreadID, e.ID, input, paths)
		}
	} else if queued {
		result = s.sender.(starter).Start(ctx, e.ThreadID, e.ID, text)
	} else {
		result = s.sender.Send(ctx, e.ThreadID, e.ID, text)
	}
	return result
}
