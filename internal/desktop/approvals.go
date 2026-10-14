package desktop

import (
	"context"
	"encoding/json"
	"errors"
)

var ErrStaleControl = errors.New("桌面状态已变化，请刷新后重新选择")

func (w *wire) control(method string, params any, owner string) error {
	r, sent, err := w.request(method, params, 1, owner)
	if err != nil {
		if sent {
			return errors.New("操作结果未确认，请刷新桌面状态后核对；不要重复提交")
		}
		return err
	}
	if r.ResultType != "success" {
		return errors.New("桌面未接受操作：" + short(r.Error))
	}
	var ack struct {
		OK bool `json:"ok"`
	}
	// The current desktop IPC returns the unwrapped receipt.
	if json.Unmarshal(r.Result, &ack) != nil || !ack.OK {
		return errors.New("桌面未返回有效确认，请刷新核对")
	}
	return nil
}
func (c *Client) Approve(ctx context.Context, thread, key, decision string) (LiveState, error) {
	if !c.controlMu.TryLock() {
		return LiveState{}, errors.New("另一个审批或权限修改正在提交，请稍后刷新")
	}
	defer c.controlMu.Unlock()
	if decision != "accept" && decision != "decline" && decision != "cancel" {
		return LiveState{}, errors.New("不支持的审批决定")
	}
	w, owner, closeLive, err := c.openLive(ctx, thread)
	if err != nil {
		return LiveState{}, err
	}
	defer closeLive()
	s, err := w.snapshot(thread, owner)
	if err != nil {
		return s, err
	}
	for _, a := range s.Approvals {
		if a.Key == key {
			allowed := false
			for _, d := range a.Decisions {
				if d == decision {
					allowed = true
				}
			}
			if !allowed {
				return s, errors.New("该请求不支持所选决定")
			}
			params := map[string]any{"conversationId": thread, "requestId": a.ID, "decision": decision}
			method := "thread-follower-command-approval-decision"
			if a.Kind == "file" {
				method = "thread-follower-file-approval-decision"
			}
			if a.Kind == "permissions" {
				method = "thread-follower-permissions-request-approval-response"
				delete(params, "decision")
				permissions := json.RawMessage(`{}`)
				if decision == "accept" {
					var p struct {
						Permissions json.RawMessage `json:"permissions"`
					}
					if json.Unmarshal(a.Params, &p) != nil || len(p.Permissions) == 0 || string(p.Permissions) == "null" {
						return s, errors.New("权限申请内容无效")
					}
					permissions = p.Permissions
				}
				params["response"] = map[string]any{"permissions": permissions, "scope": "turn"}
			}
			if err = w.control(method, params, owner); err != nil {
				return s, err
			}
			next, err := w.snapshot(thread, owner)
			if err != nil {
				return next, errors.New("决定已提交，状态回读失败，请刷新核对")
			}
			for _, pending := range next.Approvals {
				if pending.Key == key {
					return next, errors.New("决定已提交，桌面仍显示待批准，请刷新核对")
				}
			}
			return next, nil
		}
	}
	return s, ErrStaleControl
}
