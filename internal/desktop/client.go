// Package desktop adapts the local, version-specific desktop follower IPC.
package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

type Result struct {
	// Retryable is set only when no message submission could have reached Codex.
	Retryable bool   `json:"-"`
	Status    string `json:"status"`
	Detail    string `json:"detail"`
	TurnID    string `json:"turnId,omitempty"`
}
type Client struct {
	Home              string
	controlMu         sync.Mutex
	Socket            string
	BeforeQueuedStart func(string) bool
	OpenThread        func(context.Context, string) error
}

var errOwnerUnavailable = errors.New("桌面尚未接管这个聊天")

// Resolve only before submitting input. Never retry a turn with an uncertain receipt.
func (c *Client) resolveOwner(ctx context.Context, w *wire, thread string) (string, error) {
	owner, err := w.owner(thread)
	if err == nil || !errors.Is(err, errOwnerUnavailable) || c.OpenThread == nil {
		return owner, err
	}
	if !threadIDPattern.MatchString(thread) {
		return "", errors.New("聊天 ID 无效，无法在桌面定位；消息未发送")
	}
	openCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = c.OpenThread(openCtx, thread)
	cancel()
	if err != nil {
		return "", errors.New("无法请求桌面打开该聊天，请检查 Codex 桌面和 codex:// 协议注册；消息未发送")
	}
	for attempt := 0; attempt < 4; attempt++ {
		select {
		case <-ctx.Done():
			return "", errors.New("等待桌面定位聊天已取消；消息未发送")
		case <-time.After(400 * time.Millisecond):
		}
		deadline := time.Now().Add(2 * time.Second)
		if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
			deadline = limit
		}
		_ = w.conn.SetDeadline(deadline)
		owner, err = w.owner(thread)
		if err == nil {
			deadline = time.Now().Add(16 * time.Second)
			if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
				deadline = limit
			}
			_ = w.conn.SetDeadline(deadline)
			return owner, nil
		}
		if !errors.Is(err, errOwnerUnavailable) {
			break
		}
	}
	return "", fmt.Errorf("已请求桌面打开该聊天，但接收方仍未确认；消息未发送：%w", err)
}
func (c *Client) Probe(ctx context.Context, thread string) error {
	w, e := c.connect(ctx)
	if e != nil {
		return e
	}
	defer w.conn.Close()
	_, e = w.owner(thread)
	return e
}

func (c *Client) Send(ctx context.Context, thread, id, text string) Result {
	return c.sendConfigured(ctx, thread, id, text, nil, false, nil)
}

// Start never falls back to steer: queued input must start a new turn.
func (c *Client) Start(ctx context.Context, thread, id, text string) Result {
	return c.sendConfigured(ctx, thread, id, text, nil, true, nil)
}
func (c *Client) SendImages(ctx context.Context, thread, id, text string, images []string) Result {
	return c.sendConfigured(ctx, thread, id, text, images, false, nil)
}

func (c *Client) StartImages(ctx context.Context, thread, id, text string, images []string) Result {
	return c.sendConfigured(ctx, thread, id, text, images, true, nil)
}

func (c *Client) StartWithSettings(ctx context.Context, thread, id, text string, images []string, settings *ModelSettings) Result {
	return c.sendConfigured(ctx, thread, id, text, images, true, settings)
}
func (c *Client) sendConfigured(ctx context.Context, thread, id, text string, images []string, startOnly bool, settings *ModelSettings) Result {
	w, e := c.connect(ctx)
	if e != nil {
		return Result{Status: "failed", Detail: e.Error(), Retryable: !errors.Is(e, errDesktopIncompatible)}
	}
	defer w.conn.Close()
	owner, e := c.resolveOwner(ctx, w, thread)
	if e != nil {
		return Result{Status: "failed", Detail: e.Error(), Retryable: threadIDPattern.MatchString(thread)}
	}
	if startOnly && (text != "" || len(images) > 0) && c.BeforeQueuedStart != nil && !c.BeforeQueuedStart(thread) {
		return Result{Status: "deferred", Detail: "聊天仍在工作，继续排队"}
	}
	input := []map[string]any{}
	if text != "" {
		input = append(input, map[string]any{"type": "text", "text": text, "text_elements": []any{}})
	}
	for _, path := range images {
		input = append(input, map[string]any{"type": "localImage", "path": path})
	}
	params := map[string]any{"conversationId": thread, "input": input, "clientUserMessageId": id, "attachments": []any{}, "restoreMessage": map[string]any{"id": id, "text": text, "context": map[string]any{"commentAttachments": []any{}}}}
	var r response
	var sent bool
	if !startOnly {
		r, sent, e = w.request("thread-follower-steer-turn", params, 1, owner)
	}
	if e != nil {
		return transportResult(sent)
	}
	// Only this explicit inactive rejection proves the steer did not submit input.
	inactive := r.ResultType == "error" && (r.Error == "NoActiveTurn" || r.Error == "no active turn to steer" || r.Error == fmt.Sprintf("Cannot steer conversation %s because its active turn already ended", thread))
	if inactive || startOnly {
		params = map[string]any{"conversationId": thread, "turnStart": map[string]any{"request": map[string]any{"threadId": thread, "input": input, "clientUserMessageId": id}, "context": map[string]any{"inheritThreadSettings": true}}}
		if settings != nil {
			req := params["turnStart"].(map[string]any)["request"].(map[string]any)
			req["model"] = settings.Model
			req["effort"] = settings.Effort
			req["serviceTier"] = nil
			if settings.Fast {
				req["serviceTier"] = "priority"
			}
		}
		r, sent, e = w.request("thread-follower-start-turn", params, 2, owner)
		if e != nil {
			return transportResult(sent)
		}
	}
	if r.ResultType != "success" {
		// A router timeout/disconnect may occur after the desktop has accepted input.
		for _, v := range []string{"timeout", "disconnected", "closed", "outcome-unknown", "not yet confirmed"} {
			if strings.Contains(strings.ToLower(r.Error), v) {
				return transportResult(true)
			}
		}
		return Result{Status: "failed", Detail: "桌面未接受消息：" + short(r.Error)}
	}
	var payload struct {
		Result struct {
			TurnID string `json:"turnId"`
			Turn   struct {
				ID string `json:"id"`
			} `json:"turn"`
		} `json:"result"`
	}
	if json.Unmarshal(r.Result, &payload) != nil {
		return transportResult(true)
	}
	turn := payload.Result.TurnID
	if turn == "" {
		turn = payload.Result.Turn.ID
	}
	if turn == "" {
		return transportResult(true)
	}
	return Result{Status: "accepted", Detail: "已送达目标电脑，等待 Codex 回复", TurnID: turn}
}
func transportResult(sent bool) Result {
	if sent {
		return Result{Status: "unknown", Detail: "送达结果尚未确认，请核对聊天后再决定是否重发"}
	}
	return Result{Status: "failed", Detail: "消息未发送，桌面连接已断开", Retryable: true}
}
func short(s string) string {
	r := []rune(s)
	if len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return s
}
