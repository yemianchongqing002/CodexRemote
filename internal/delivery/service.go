// Package delivery persists submission metadata before invoking desktop IPC.
package delivery

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"codexremote/internal/desktop"
	"codexremote/internal/platform"
)

type Sender interface {
	Send(context.Context, string, string, string) desktop.Result
}
type Entry struct {
	Attempts          int                    `json:"attempts,omitempty"`
	NextRetryAt       time.Time              `json:"nextRetryAt,omitempty"`
	ID                string                 `json:"id"`
	Mode              string                 `json:"mode,omitempty"`
	ThreadID          string                 `json:"threadId"`
	Digest            string                 `json:"digest"`
	Status            string                 `json:"status"`
	Detail            string                 `json:"detail"`
	TurnID            string                 `json:"turnId,omitempty"`
	At                time.Time              `json:"at"`
	QueuedAt          time.Time              `json:"queuedAt,omitempty"`
	CompletionVersion string                 `json:"completionVersion,omitempty"`
	Images            []string               `json:"images,omitempty"`
	ModelSettings     *desktop.ModelSettings `json:"modelSettings,omitempty"`
}
type Service struct {
	stop       chan struct{}
	retryDelay time.Duration
	mu         sync.Mutex
	sender     Sender
	file       *os.File
	entries    map[string]Entry
	working    map[string]bool
	wg         sync.WaitGroup
	closed     bool
	diskErr    error
	revision   uint64
	queueDir   string
	queued     map[string]string
	idleSeen   map[string]string
	queueWake  chan struct{}
	changes    chan struct{}
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,100}$`)
var ErrConflict = errors.New("请求 ID 已用于另一条消息")
var ErrBusy = errors.New("还有消息等待确认，请稍后再发送")

func Open(path string, sender Sender) (*Service, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	if info, e := os.Lstat(path); e == nil && (!info.Mode().IsRegular() || !platform.PrivateMode(info)) {
		return nil, errors.New("outbox 必须是 0600 普通文件")
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = platform.Lock(f); e != nil {
		f.Close()
		return nil, errors.New("outbox 正被另一个服务使用")
	}
	s := &Service{stop: make(chan struct{}), retryDelay: sendRetryInterval, sender: sender, file: f, entries: map[string]Entry{}, working: map[string]bool{}, queueDir: path + ".queue", queued: map[string]string{}, idleSeen: map[string]string{}, queueWake: make(chan struct{}, 1), changes: make(chan struct{})}
	// Recover a trailing partial record only. Invalid complete records fail closed.
	r := bufio.NewReader(f)
	offset := int64(0)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 64<<10 {
			f.Close()
			return nil, errors.New("outbox 记录过大")
		}
		if err != nil {
			if err != io.EOF {
				f.Close()
				return nil, err
			}
			if len(line) > 0 {
				if e = f.Truncate(offset); e != nil {
					f.Close()
					return nil, e
				}
			}
			break
		}
		var entry Entry
		if json.Unmarshal(line, &entry) != nil || !validID.MatchString(entry.ID) {
			f.Close()
			return nil, errors.New("outbox 损坏，发送保持禁用")
		}
		offset += int64(len(line))
		if entry.Status == "pending" {
			entry.Status = "unknown"
			entry.NextRetryAt = time.Time{}
			entry.Detail = "服务重启前的发送未确认，请先核对聊天"
		}
		s.entries[entry.ID] = entry
	}
	if _, e = f.Seek(0, 2); e != nil {
		f.Close()
		return nil, e
	}
	if e := s.restoreQueue(); e != nil {
		f.Close()
		return nil, e
	}
	return s, nil
}
func (s *Service) persist(entry Entry) error {
	s.revision++
	close(s.changes)
	s.changes = make(chan struct{})
	b, e := json.Marshal(entry)
	if e != nil {
		return e
	}
	b = append(b, '\n')
	_, e = s.file.Write(b)
	if e != nil {
		return e
	}
	return s.file.Sync()
}
func (s *Service) Submit(id, thread, text string, modes ...string) (Entry, error) {
	return s.SubmitImages(id, thread, text, nil, modes...)
}

func (s *Service) SubmitImages(id, thread, text string, images []string, modes ...string) (Entry, error) {
	return s.SubmitWithSettings(id, thread, text, images, nil, modes...)
}
func (s *Service) SubmitWithSettings(id, thread, text string, images []string, settings *desktop.ModelSettings, modes ...string) (Entry, error) {
	if settings != nil {
		copy := *settings
		settings = &copy
	}
	mode := "steer"
	if len(modes) > 0 && modes[0] != "" {
		mode = modes[0]
	}
	if mode != "steer" && mode != "queue" {
		return Entry{}, errors.New("请选择排队发送或立即引导")
	}
	if !validID.MatchString(id) || (strings.TrimSpace(text) == "" && len(images) == 0) || len(text) > 16<<10 {
		return Entry{}, errors.New("正文不能为空且不能超过 16 KiB，请求 ID 必须有效")
	}
	if settings != nil {
		if mode != "queue" {
			return Entry{}, errors.New("模型设置随下一轮发送，请使用排队")
		}
		if _, ok := s.sender.(settingsSender); !ok {
			return Entry{}, errors.New("发送器不支持模型设置")
		}
	}
	digest := settingsDigest(thread, text, images, settings)
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.entries[id]; ok {
		oldMode := old.Mode
		if oldMode == "" {
			oldMode = "steer"
		}
		if old.Digest != digest || oldMode != mode {
			return Entry{}, ErrConflict
		}
		return old, nil
	}
	if s.closed || s.diskErr != nil {
		return Entry{}, errors.New("发送记录不可写，发送已暂停")
	}
	if len(images) > 0 {
		if _, ok := s.sender.(imageSender); !ok {
			return Entry{}, errors.New("此发送器不支持图片")
		}
		if _, err := s.imagePaths(images); err != nil {
			return Entry{}, err
		}
	}
	if len(s.entries) >= 10000 {
		return Entry{}, errors.New("发送记录已达上限，请在电脑维护 outbox")
	}
	if mode == "queue" {
		return s.enqueue(id, thread, text, digest, images, settings)
	}
	if s.working[thread] || len(s.working) >= 4 {
		return Entry{}, ErrBusy
	}
	e := Entry{Mode: mode, ID: id, ThreadID: thread, Digest: digest, Status: "pending", Detail: "正在发送到目标电脑", At: time.Now().UTC()}
	e.Images = append([]string(nil), images...)
	if err := s.persist(e); err != nil {
		s.diskErr = err
		return Entry{}, errors.New("无法保存发送记录，消息未发送")
	}
	s.entries[id] = e
	s.dispatch(e, text, false)
	return e, nil
}
func (s *Service) Get(id string) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	return e, ok
}
func (s *Service) Close() error {
	s.mu.Lock()
	if !s.closed {
		close(s.stop)
	}
	s.closed = true
	s.mu.Unlock()
	s.wg.Wait()
	return s.file.Close()
}

func (s *Service) Revision() uint64 { s.mu.Lock(); defer s.mu.Unlock(); return s.revision }

// Changes broadcasts a revision update to all current SSE viewers.
func (s *Service) Changes() <-chan struct{} { s.mu.Lock(); defer s.mu.Unlock(); return s.changes }
