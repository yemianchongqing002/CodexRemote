package desktop

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
)

type Approval struct {
	Key       string          `json:"key"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Changes   json.RawMessage `json:"changes,omitempty"`
	Decisions []string        `json:"decisions"`
	ID        json.RawMessage `json:"-"`
}

type LiveState struct {
	PermissionSelection     *PermissionSelection `json:"permissionSelection,omitempty"`
	Model                   string               `json:"model,omitempty"`
	Effort                  string               `json:"effort,omitempty"`
	ApprovalPolicy          json.RawMessage      `json:"approvalPolicy,omitempty"`
	ApprovalsReviewer       string               `json:"approvalsReviewer,omitempty"`
	ActivePermissionProfile json.RawMessage      `json:"activePermissionProfile,omitempty"`
	SandboxPolicy           json.RawMessage      `json:"sandboxPolicy,omitempty"`
	PermissionVersion       string               `json:"permissionVersion"`
	Approvals               []Approval           `json:"approvals"`
	Cwd                     string               `json:"-"`
	Roots                   []string             `json:"-"`
}

func (s LiveState) profileID() string {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(s.ActivePermissionProfile, &p)
	return p.ID
}

func digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func parseLive(thread string, raw json.RawMessage) (LiveState, error) {
	var d struct {
		ID          string                     `json:"id"`
		Cwd         string                     `json:"cwd"`
		Settings    map[string]json.RawMessage `json:"latestThreadSettings"`
		Permissions map[string]json.RawMessage `json:"currentPermissions"`
		Requests    []struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		} `json:"requests"`
	}
	if json.Unmarshal(raw, &d) != nil || d.ID != thread {
		return LiveState{}, errors.New("桌面快照会话标识不匹配")
	}
	s := LiveState{Approvals: []Approval{}, Cwd: d.Cwd}
	_ = json.Unmarshal(d.Permissions["runtimeWorkspaceRoots"], &s.Roots)
	_ = json.Unmarshal(d.Settings["model"], &s.Model)
	_ = json.Unmarshal(d.Settings["effort"], &s.Effort)
	p := d.Settings
	s.ApprovalPolicy = p["approvalPolicy"]
	s.ActivePermissionProfile = p["activePermissionProfile"]
	s.SandboxPolicy = p["sandboxPolicy"]
	_ = json.Unmarshal(p["approvalsReviewer"], &s.ApprovalsReviewer)
	s.PermissionVersion = digest(map[string]any{"thread": thread, "cwd": s.Cwd, "roots": s.Roots, "sandbox": p["sandboxPolicy"], "profile": p["activePermissionProfile"], "policy": p["approvalPolicy"], "reviewer": p["approvalsReviewer"]})
	for _, r := range d.Requests {
		kind := ""
		switch r.Method {
		case "item/commandExecution/requestApproval":
			kind = "command"
		case "item/fileChange/requestApproval":
			kind = "file"
		case "item/permissions/requestApproval":
			kind = "permissions"
		default:
			continue
		}
		var params struct {
			Thread    string            `json:"threadId"`
			Item      string            `json:"itemId"`
			Decisions []json.RawMessage `json:"availableDecisions"`
		}
		if json.Unmarshal(r.Params, &params) != nil || params.Thread != thread || len(r.ID) == 0 || string(r.ID) == "null" {
			continue
		}
		a := Approval{Kind: kind, ID: r.ID, Params: r.Params, Decisions: []string{"accept", "decline"}}
		if kind == "command" && params.Decisions != nil {
			a.Decisions = []string{}
			for _, v := range params.Decisions {
				var decision string
				_ = json.Unmarshal(v, &decision)
				if decision == "accept" || decision == "decline" || decision == "cancel" {
					a.Decisions = append(a.Decisions, decision)
				}
			}
		}
		if kind == "file" {
			var tree any
			_ = json.Unmarshal(raw, &tree)
			a.Changes = findChanges(tree, params.Item)
		}
		a.Key = digest([]any{thread, r.ID, r.Method, r.Params, a.Changes})
		s.Approvals = append(s.Approvals, a)
	}
	return s, nil
}
func findChanges(v any, id string) json.RawMessage {
	if id == "" {
		return nil
	}
	switch x := v.(type) {
	case map[string]any:
		if (x["id"] == id || x["callId"] == id) && (x["type"] == "fileChange" || x["type"] == "patch") {
			b, _ := json.Marshal(x)
			return b
		}
		keys := make([]string, 0, len(x))
		for key := range x {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := x[key]
			if b := findChanges(child, id); b != nil {
				return b
			}
		}
	case []any:
		for _, child := range x {
			if b := findChanges(child, id); b != nil {
				return b
			}
		}
	}
	return nil
}
