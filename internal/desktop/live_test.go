package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

const liveThread = "00000000-0000-0000-0000-000000000001"

func liveFixture(kind string) map[string]any {
	method := map[string]string{"command": "item/commandExecution/requestApproval", "file": "item/fileChange/requestApproval", "permissions": "item/permissions/requestApproval"}[kind]
	return map[string]any{"id": liveThread, "cwd": "/project", "latestThreadSettings": map[string]any{"model": "example", "effort": "high", "approvalPolicy": "on-request", "approvalsReviewer": "user", "sandboxPolicy": map[string]any{"type": "workspaceWrite", "networkAccess": false, "excludeSlashTmp": false, "excludeTmpdirEnvVar": false}}, "requests": []any{map[string]any{"id": 42, "method": method, "params": map[string]any{"threadId": liveThread, "turnId": "turn", "itemId": "item", "command": "echo hello", "permissions": map[string]any{"network": map[string]any{"enabled": true}}}}}}
}
func parsedFixture(t *testing.T, d map[string]any) LiveState {
	t.Helper()
	b, _ := json.Marshal(d)
	s, e := parseLive(liveThread, b)
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func snapshotFrame(d map[string]any) map[string]any {
	return map[string]any{"type": "broadcast", "method": "thread-stream-state-changed", "sourceClientId": "desktop-owner", "version": 11, "params": map[string]any{"hostId": "local", "conversationId": liveThread, "change": map[string]any{"type": "snapshot", "conversationState": d}}}
}
func TestLiveApprovalRoundTrip(t *testing.T) {
	for _, kind := range []string{"command", "file", "permissions"} {
		for _, decision := range []string{"accept", "decline"} {
			t.Run(kind+decision, func(t *testing.T) {
				d := liveFixture(kind)
				before := parsedFixture(t, d)
				calls := make(chan map[string]any, 1)
				c := fakeSocket(t, func(r map[string]any) map[string]any {
					if r["type"] == "broadcast" {
						return snapshotFrame(d)
					}
					calls <- r
					d["requests"] = []any{}
					return map[string]any{"resultType": "success", "result": map[string]any{"ok": true}}
				})
				next, err := c.Approve(context.Background(), liveThread, before.Approvals[0].Key, decision)
				if err != nil || len(next.Approvals) != 0 {
					t.Fatal(next, err)
				}
				r := <-calls
				p := r["params"].(map[string]any)
				if r["version"] != float64(1) || r["targetClientId"] != "desktop-owner" || p["requestId"] != float64(42) || p["conversationId"] != liveThread {
					t.Fatal(r)
				}
				method := map[string]string{"command": "thread-follower-command-approval-decision", "file": "thread-follower-file-approval-decision", "permissions": "thread-follower-permissions-request-approval-response"}[kind]
				if r["method"] != method {
					t.Fatal(r)
				}
				if kind == "permissions" {
					v := p["response"].(map[string]any)
					if v["scope"] != "turn" {
						t.Fatal(v)
					}
					granted := v["permissions"].(map[string]any)
					if (decision == "accept") != (len(granted) > 0) {
						t.Fatal(v)
					}
				} else if p["decision"] != decision {
					t.Fatal(p)
				}
			})
		}
	}
}
func TestStaleApprovalNeverSubmitted(t *testing.T) {
	d := liveFixture("command")
	key := parsedFixture(t, d).Approvals[0].Key
	d["requests"].([]any)[0].(map[string]any)["params"].(map[string]any)["command"] = "different command"
	calls := make(chan map[string]any, 1)
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		if r["type"] == "broadcast" {
			return snapshotFrame(d)
		}
		calls <- r
		return nil
	})
	_, err := c.Approve(context.Background(), liveThread, key, "accept")
	if !errors.Is(err, ErrStaleControl) {
		t.Fatal(err)
	}
	select {
	case r := <-calls:
		t.Fatal("submitted stale approval", r)
	default:
	}
}
func TestPermissionsReadbackAndWhitelist(t *testing.T) {
	for _, wanted := range []PermissionSettings{{"never", "user", ":danger-full-access"}, {"on-request", "user", ":read-only"}, {"on-request", "user", ":workspace"}, {"on-request", "auto_review", ":workspace"}} {
		t.Run(wanted.Permissions+"/"+wanted.ApprovalsReviewer, func(t *testing.T) {
			d := liveFixture("command")
			before := parsedFixture(t, d)
			before.withPermissionSelection("")
			version := before.PermissionVersion
			calls := make(chan map[string]any, 1)
			snapshotsAfterWrite := 0
			var patch map[string]any
			c := fakeSocket(t, func(r map[string]any) map[string]any {
				if r["type"] == "broadcast" {
					if patch != nil {
						snapshotsAfterWrite++
						if snapshotsAfterWrite == 2 {
							settings := d["latestThreadSettings"].(map[string]any)
							profile := patch["permissions"].(string)
							settings["activePermissionProfile"] = map[string]any{"id": profile, "extends": nil}
							settings["approvalPolicy"] = patch["approvalPolicy"]
							settings["approvalsReviewer"] = patch["approvalsReviewer"]
							settings["sandboxPolicy"] = map[string]any{"type": map[string]string{":danger-full-access": "dangerFullAccess", ":workspace": "workspaceWrite", ":read-only": "readOnly"}[profile], "networkAccess": false, "excludeSlashTmp": false, "excludeTmpdirEnvVar": false}
						}
					}
					return snapshotFrame(d)
				}
				calls <- r
				patch = r["params"].(map[string]any)["threadSettings"].(map[string]any)
				if patch["sandboxPolicy"] != nil || patch["mode"] != nil {
					return map[string]any{"resultType": "error", "error": "unexpected non-Codex settings"}
				}
				return map[string]any{"resultType": "success", "result": map[string]any{"applied": true}}
			})
			next, err := c.SetPermissions(context.Background(), liveThread, version, wanted)
			if err != nil {
				t.Fatal(next, err)
			}
			r := <-calls
			settings := r["params"].(map[string]any)["threadSettings"].(map[string]any)
			if len(settings) != 3 || settings["permissions"] != wanted.Permissions || settings["approvalPolicy"] != wanted.ApprovalPolicy || settings["approvalsReviewer"] != wanted.ApprovalsReviewer {
				t.Fatal(settings)
			}
			if next.profileID() != wanted.Permissions || next.ApprovalsReviewer != wanted.ApprovalsReviewer || next.Model != "example" || next.Effort != "high" || snapshotsAfterWrite != 2 {
				t.Fatal(next, snapshotsAfterWrite)
			}
			select {
			case extra := <-calls:
				t.Fatal("repeated mutation", extra)
			default:
			}
		})
	}
	c := &Client{}
	for _, settings := range []PermissionSettings{{"on-request", "guardian_subagent", ":workspace"}, {"on-request", "auto", ":workspace"}, {"never", "user", ":arbitrary"}} {
		if _, err := c.SetPermissions(context.Background(), liveThread, "", settings); err == nil {
			t.Fatal("non-current wire values accepted", settings)
		}
	}
}
func TestPermissionsUnconfirmedReadback(t *testing.T) {
	d := liveFixture("command")
	before := parsedFixture(t, d)
	before.withPermissionSelection("")
	version := before.PermissionVersion
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		if r["type"] == "broadcast" {
			return snapshotFrame(d)
		}
		return map[string]any{"resultType": "success", "result": map[string]any{"applied": true}}
	})
	if _, err := c.SetPermissions(context.Background(), liveThread, version, PermissionSettings{"never", "user", ":danger-full-access"}); err == nil {
		t.Fatal("claimed success without changed settings")
	}
}
func TestLiveFiltersAndDecisions(t *testing.T) {
	d := liveFixture("command")
	params := d["requests"].([]any)[0].(map[string]any)["params"].(map[string]any)
	params["availableDecisions"] = []string{"decline", "cancel"}
	s := parsedFixture(t, d)
	if len(s.Approvals[0].Decisions) != 2 || s.Approvals[0].Decisions[0] != "decline" {
		t.Fatal(s)
	}
	encoded, _ := json.Marshal(s)
	var public map[string]any
	_ = json.Unmarshal(encoded, &public)
	if public["cwd"] != nil || public["latestThreadSettings"] != nil {
		t.Fatal(string(encoded))
	}
	params["threadId"] = "another-thread"
	if len(parsedFixture(t, d).Approvals) != 0 {
		t.Fatal("cross-thread request exposed")
	}
}

// Opt-in integration probe: reads only, never submits decisions or changes settings.
func TestLiveDesktopReadOnly(t *testing.T) {
	socket, thread := os.Getenv("CODEX_REMOTE_TEST_SOCKET"), os.Getenv("CODEX_REMOTE_TEST_THREAD")
	if socket == "" || thread == "" {
		t.Skip("set desktop socket and thread to run read-only integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	s, err := (&Client{Socket: socket}).Live(ctx, thread)
	if err != nil {
		t.Fatal(err)
	}
	if s.PermissionVersion == "" {
		t.Fatal("missing state version")
	}
	t.Logf("desktop model=%s effort=%s reviewer=%s profile=%s pending=%d", s.Model, s.Effort, s.ApprovalsReviewer, s.profileID(), len(s.Approvals))
}

func TestControlReceiptFormats(t *testing.T) {
	for _, tc := range []struct {
		name     string
		receipt  any
		accepted bool
	}{
		{"desktop", map[string]any{"ok": true}, true},
		{"wrapped", map[string]any{"result": map[string]any{"ok": true}}, false},
		{"missing", map[string]any{}, false},
		{"rejected", map[string]any{"ok": false}, false},
		{"conflicting", map[string]any{"ok": false, "result": map[string]any{"ok": true}}, false},
		{"wrong-type", map[string]any{"ok": "true"}, false},
		{"null", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := fakeSocket(t, func(r map[string]any) map[string]any {
				return map[string]any{"resultType": "success", "result": tc.receipt}
			})
			w, owner, err := c.liveWire(context.Background(), liveThread)
			if err != nil {
				t.Fatal(err)
			}
			defer w.conn.Close()
			err = w.control("thread-follower-update-thread-settings", map[string]any{"conversationId": liveThread}, owner)
			if (err == nil) != tc.accepted {
				t.Fatalf("receipt %v: %v", tc.receipt, err)
			}
		})
	}
}
func TestPermissionValuesAreNotRewritten(t *testing.T) {
	for _, reviewer := range []string{"user", "auto_review", "guardian_subagent"} {
		d := liveFixture("command")
		p := d["latestThreadSettings"].(map[string]any)
		p["approvalsReviewer"] = reviewer
		p["activePermissionProfile"] = map[string]any{"id": ":workspace", "extends": nil}
		d["currentPermissions"] = map[string]any{"approvalsReviewer": "different", "approvalPolicy": "never"}
		state := parsedFixture(t, d)
		if state.ApprovalsReviewer != reviewer || state.profileID() != ":workspace" {
			t.Fatal(state)
		}
		raw, _ := json.Marshal(state)
		var wire map[string]any
		_ = json.Unmarshal(raw, &wire)
		if wire["approvalsReviewer"] != reviewer || wire["approvalPolicy"] != "on-request" || wire["permissionMode"] != nil || wire["permissionProfile"] != nil {
			t.Fatal(string(raw))
		}
		delete(d, "latestThreadSettings")
		if state := parsedFixture(t, d); state.ApprovalsReviewer != "" || len(state.ApprovalPolicy) != 0 {
			t.Fatal("old turn used as next-turn settings", state)
		}
	}
}
