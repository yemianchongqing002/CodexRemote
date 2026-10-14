package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// PermissionSettings uses the current Codex thread/settings/update field names.
type PermissionSettings struct {
	ApprovalPolicy    string `json:"approvalPolicy"`
	ApprovalsReviewer string `json:"approvalsReviewer"`
	Permissions       string `json:"permissions"`
}

func (p PermissionSettings) Valid() bool {
	switch p.Permissions {
	case ":workspace":
		return p.ApprovalPolicy == "on-request" && (p.ApprovalsReviewer == "user" || p.ApprovalsReviewer == "auto_review")
	case ":read-only":
		return p.ApprovalPolicy == "on-request" && p.ApprovalsReviewer == "user"
	case ":danger-full-access":
		return p.ApprovalPolicy == "never" && p.ApprovalsReviewer == "user"
	}
	return false
}
func sameReviewer(actual, wanted string) bool {
	return actual == wanted || wanted == "auto_review" && actual == "guardian_subagent"
}

func (c *Client) SetPermissions(ctx context.Context, thread, version string, settings PermissionSettings) (LiveState, error) {
	if !c.controlMu.TryLock() {
		return LiveState{}, errors.New("另一个审批或权限修改正在提交，请稍后刷新")
	}
	defer c.controlMu.Unlock()
	if !settings.Valid() {
		return LiveState{}, errors.New("不支持的权限设置")
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
	if s.PermissionVersion != version {
		return s, ErrStaleControl
	}
	if err = w.updateThreadSettings(map[string]any{"conversationId": thread, "threadSettings": settings}, owner); err != nil {
		return s, err
	}
	// The acknowledgement can precede the normalized settings broadcast. Re-read
	// the desktop state until it confirms this one write; never retry the mutation.
	deadline := time.Now().Add(3 * time.Second)
	for {
		next, err := w.snapshot(thread, owner)
		if err != nil {
			return next, errors.New("设置已提交，状态回读失败，请刷新核对")
		}
		var policy string
		_ = json.Unmarshal(next.ApprovalPolicy, &policy)
		if next.profileID() == settings.Permissions && policy == settings.ApprovalPolicy && sameReviewer(next.ApprovalsReviewer, settings.ApprovalsReviewer) {
			return next, nil
		}
		if time.Now().After(deadline) {
			return next, errors.New("会话尚未确认所选审批模式，请刷新核对")
		}
		select {
		case <-ctx.Done():
			return next, errors.New("设置已提交，状态回读超时，请刷新核对")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// v2 adds conditional updates and returns applied instead of ok. Only retry the
// legacy version after an explicit protocol/router rejection before dispatch.
func (w *wire) updateThreadSettings(params any, owner string) error {
	for _, version := range []int{2, 1} {
		r, sent, err := w.request("thread-follower-update-thread-settings", params, version, owner)
		if err != nil {
			if sent {
				return errors.New("操作结果未确认，请刷新会话状态后核对；不要重复提交")
			}
			return err
		}
		if r.ResultType != "success" {
			if version == 2 && r.Owner == "" && (r.Error == "no-client-found" || r.Error == "request-version-mismatch") {
				continue
			}
			return errors.New("桌面未接受操作：" + short(r.Error))
		}
		var ack struct {
			Applied *bool `json:"applied"`
			OK      *bool `json:"ok"`
		}
		if json.Unmarshal(r.Result, &ack) != nil {
			return errors.New("桌面未返回有效确认，请刷新核对")
		}
		value := ack.Applied
		if version == 1 {
			value = ack.OK
		}
		if value == nil {
			return errors.New("桌面未返回有效确认，请刷新核对")
		}
		if !*value {
			return ErrStaleControl
		}
		return nil
	}
	return errors.New("桌面权限修改接口不可用，请在 Codex 中打开该会话后重新同步")
}
