package server

import (
	"codexremote/internal/delivery"
	"codexremote/internal/desktop"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

type fakeControls struct {
	calls int
	err   error
}

func (f *fakeControls) Live(context.Context, string) (desktop.LiveState, error) {
	f.calls++
	return desktop.LiveState{ApprovalsReviewer: "user", ApprovalPolicy: json.RawMessage(`"never"`), ActivePermissionProfile: json.RawMessage(`{"id":":danger-full-access","extends":null}`), Approvals: []desktop.Approval{}}, f.err
}
func (f *fakeControls) Approve(context.Context, string, string, string) (desktop.LiveState, error) {
	return f.Live(context.Background(), "")
}
func (f *fakeControls) SetPermissions(context.Context, string, string, desktop.PermissionSettings) (desktop.LiveState, error) {
	return f.Live(context.Background(), "")
}
func TestLiveControlHTTPBoundaries(t *testing.T) {
	s, _ := setup(t)
	cookie := loginCookie(t, s)
	for _, route := range []struct{ method, path string }{{"GET", "/api/thread/live?threadId=test"}, {"POST", "/api/thread/approval"}, {"POST", "/api/thread/permissions"}} {
		if w := request(s, route.method, route.path, "{}", nil); w.Code != 401 {
			t.Fatal(w.Code)
		}
		if w := request(s, route.method, route.path, "{}", cookie); w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	out, err := delivery.Open(filepath.Join(t.TempDir(), "outbox"), testSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	s.cfg.Delivery = out
	controls := &fakeControls{}
	s.cfg.LiveControl = controls
	s.store.Refresh(true)
	if w := request(s, "GET", "/api/thread/live?threadId=test", "", cookie); w.Code != 200 || !strings.Contains(w.Body.String(), "danger-full-access") {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, body := range []string{`{"threadId":"test","mode":"arbitrary"}`, `{"threadId":"test","mode":"full-access","version":"` + strings.Repeat("a", 64) + `","rpc":"x"}`} {
		if w := request(s, "POST", "/api/thread/permissions", body, cookie); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	if controls.calls != 1 {
		t.Fatal("invalid settings reached desktop")
	}
	body := `{"threadId":"test","approvalPolicy":"never","approvalsReviewer":"user","permissions":":danger-full-access","version":"` + strings.Repeat("a", 64) + `"}`
	controls.err = desktop.ErrStaleControl
	if w := request(s, "POST", "/api/thread/permissions", body, cookie); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w := request(s, "GET", "/api/thread/live?threadId=missing", "", cookie); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
