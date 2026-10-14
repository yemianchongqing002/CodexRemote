package delivery

import (
	"codexremote/internal/desktop"
	"context"
	"fmt"
	"time"
)

const sendRetryInterval = 30 * time.Second
const maxSendAttempts = 3

// Keep the original request ID, body, attachments and settings for each attempt.
// Pending retries continue on the server even when the browser is closed.
func (s *Service) deliverWithRetry(e *Entry, text string, queued bool) desktop.Result {
	for attempt := 1; attempt <= maxSendAttempts; attempt++ {
		s.mu.Lock()
		if s.closed || s.diskErr != nil {
			s.mu.Unlock()
			return desktop.Result{Status: "failed", Detail: "发送已停止，消息未提交到 Codex"}
		}
		e.Attempts = attempt
		e.NextRetryAt = time.Time{}
		e.Detail = fmt.Sprintf("正在等待 Codex 响应（第 %d/%d 次尝试）", attempt, maxSendAttempts)
		e.At = time.Now().UTC()
		if err := s.persist(*e); err != nil {
			s.diskErr = err
			s.mu.Unlock()
			return desktop.Result{Status: "failed", Detail: "无法保存发送状态，消息未发送"}
		}
		s.entries[e.ID] = *e
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		result := s.attemptDelivery(ctx, *e, text, queued)
		cancel()
		if result.Status != "failed" || !result.Retryable {
			return result
		}
		if attempt == maxSendAttempts {
			result.Detail = fmt.Sprintf("已尝试 %d 次仍未能发送：%s", maxSendAttempts, result.Detail)
			return result
		}
		s.mu.Lock()
		e.NextRetryAt = time.Now().UTC().Add(s.retryDelay)
		e.Detail = fmt.Sprintf("Codex 暂未响应，%g 秒后自动重试（已尝试 %d/%d 次）", s.retryDelay.Seconds(), attempt, maxSendAttempts)
		e.At = time.Now().UTC()
		if err := s.persist(*e); err != nil {
			s.diskErr = err
			s.mu.Unlock()
			return desktop.Result{Status: "failed", Detail: "无法保存重试状态，已停止发送"}
		}
		s.entries[e.ID] = *e
		s.mu.Unlock()
		timer := time.NewTimer(s.retryDelay)
		select {
		case <-s.stop:
			timer.Stop()
			return desktop.Result{Status: "failed", Detail: "服务已停止，消息未发送"}
		case <-timer.C:
		}
	}
	panic("unreachable")
}
