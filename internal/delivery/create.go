package delivery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

type Creator interface {
	Create(context.Context, string, string) (string, error)
}

// Create shares the durable idempotency journal and concurrency bound with sending.
func (s *Service) Create(id, path, text string, c Creator) (Entry, error) {
	if !validID.MatchString(id) || strings.TrimSpace(text) == "" || len(text) > 16<<10 {
		return Entry{}, errors.New("请求 ID 无效")
	}
	hash := sha256.Sum256([]byte("create\x00" + path + "\x00" + text))
	digest := hex.EncodeToString(hash[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.entries[id]; ok {
		if old.Mode != "create" || old.Digest != digest {
			return Entry{}, ErrConflict
		}
		return old, nil
	}
	if s.closed || s.diskErr != nil || len(s.entries) >= 10000 {
		return Entry{}, errors.New("创建记录不可写")
	}
	if len(s.working) >= 4 || s.working["create"] {
		return Entry{}, ErrBusy
	}
	e := Entry{ID: id, ThreadID: path, Mode: "create", Digest: digest, Status: "pending", Detail: "正在项目目录创建新会话", At: time.Now().UTC()}
	if err := s.persist(e); err != nil {
		s.diskErr = err
		return Entry{}, errors.New("无法保存创建记录")
	}
	s.entries[id] = e
	s.working["create"] = true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
		defer cancel()
		thread, err := c.Create(ctx, path, text)
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.working, "create")
		e.At = time.Now().UTC()
		if thread != "" {
			e.ThreadID = thread
			e.Status = "created"
			e.Detail = "新会话已创建，首条消息已保存"
			if err != nil {
				e.Status = "created_unconfirmed"
				e.Detail = err.Error()
			}
		} else {
			e.Status = "unknown"
			e.Detail = "创建结果未确认，请先核对电脑，不要重复创建"
			if err != nil {
				e.Detail += "：" + err.Error()
			}
		}
		if err := s.persist(e); err != nil {
			s.diskErr = err
			e.Status = "unknown"
			e.Detail = "创建回执保存失败，请核对电脑"
		}
		s.entries[id] = e
	}()
	return e, nil
}
