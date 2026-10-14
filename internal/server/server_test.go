package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codexremote/internal/chat"
	"codexremote/internal/delivery"
	"codexremote/internal/desktop"
	"codexremote/internal/testutil"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef"

func setup(t *testing.T) (*Server, string) {
	t.Helper()
	home := t.TempDir()
	db := testutil.Desktop(t, home)
	testutil.Exec(t, db, `INSERT INTO threads(id,title) VALUES ('test','测试任务')`)
	os.MkdirAll(filepath.Join(home, "sessions"), 0700)
	p := filepath.Join(home, "sessions", "log.jsonl")
	os.WriteFile(p, []byte("{\"type\":\"session_meta\",\"payload\":{\"id\":\"test\",\"originator\":\"Codex Desktop\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<script>alert(1)</script>\"}]}}\n"), 0600)
	store, e := chat.New(home)
	if e != nil {
		t.Fatal(e)
	}
	return New(store, Config{Token: testToken, AllowedHosts: []string{"localhost", "127.0.0.1"}, Interval: time.Second}), p
}

type testSender struct{}

func (testSender) Send(context.Context, string, string, string) desktop.Result {
	return desktop.Result{Status: "accepted", TurnID: "turn-test", Detail: "accepted"}
}
func TestSendEndpointScopeAndReceipts(t *testing.T) {
	s, _ := setup(t)
	cookie := loginCookie(t, s)
	body := `{"id":"0123456789abcdef0123456789abcdef","threadId":"test","text":"hello"}`
	if w := request(s, "POST", "/api/send", body, cookie); w.Code != 403 {
		t.Fatal("send enabled by default")
	}
	out, e := delivery.Open(filepath.Join(t.TempDir(), "outbox"), testSender{})
	if e != nil {
		t.Fatal(e)
	}
	defer out.Close()
	s.cfg.Delivery = out
	if w := request(s, "POST", "/api/send", body, nil); w.Code != 401 {
		t.Fatal("unauthenticated send")
	}
	if w := request(s, "POST", "/api/send", `{"id":"0123456789abcdef","threadId":"missing","text":"hello"}`, cookie); w.Code != 404 {
		t.Fatal("unknown thread")
	}
	if w := request(s, "POST", "/api/send", `{"id":"0123456789abcdef","threadId":"test","text":"hello","method":"command/exec"}`, cookie); w.Code != 400 {
		t.Fatal("arbitrary RPC accepted")
	}
	w := request(s, "POST", "/api/send", body, cookie)
	if w.Code != 202 {
		t.Fatal(w.Code)
	}
	for n := 0; n < 100; n++ {
		w = request(s, "GET", "/api/send-status?id=0123456789abcdef0123456789abcdef", "", cookie)
		var e delivery.Entry
		json.Unmarshal(w.Body.Bytes(), &e)
		if e.Status == "accepted" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(w.Body.String(), "accepted") {
		t.Fatal(w.Body.String())
	}
	if w = request(s, "POST", "/api/send", body, cookie); w.Code != 200 {
		t.Fatal("retry not idempotent")
	}
}
func request(s *Server, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func loginCookie(t *testing.T, s *Server) *http.Cookie {
	t.Helper()
	w := request(s, "POST", "/api/login", `{"token":"`+testToken+`"}`, nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	return w.Result().Cookies()[0]
}

func TestAuthenticationAndReadOnly(t *testing.T) {
	s, _ := setup(t)
	if w := request(s, "GET", "/api/threads", "", nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/login", `{"token":"wrong"}`, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	c := loginCookie(t, s)
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatal("weak cookie")
	}
	w := request(s, "GET", "/api/thread?id=test", "", c)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var p chat.Page
	if e := json.Unmarshal(w.Body.Bytes(), &p); e != nil || len(p.Messages) != 1 || p.Messages[0].Text != "<script>alert(1)</script>" {
		t.Fatal("incorrect message")
	}
	if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("missing security headers")
	}
	for _, path := range []string{"/api/threads", "/api/thread", "/api/events"} {
		if w := request(s, "POST", path, "{}", c); w.Code != 405 {
			t.Fatalf("write allowed %s", path)
		}
	}
	if w := request(s, "GET", "/api/thread?id=../../secret", "", c); w.Code != 400 {
		t.Fatal("path traversal")
	}
	if w := request(s, "GET", "/api/thread?id=missing", "", c); w.Code != 404 {
		t.Fatal("missing thread")
	}
	if w := request(s, "GET", "/api/thread?id=test&before=x&after=y", "", c); w.Code != 400 {
		t.Fatal("conflicting cursors")
	}
	if w := request(s, "GET", "/api/turn/start", "", c); w.Code != 404 {
		t.Fatal("unexpected action route")
	}
	c.Value += "tampered"
	if w := request(s, "GET", "/api/threads", "", c); w.Code != 401 {
		t.Fatal("accepted tampering")
	}
}
func TestOriginAndHostBoundary(t *testing.T) {
	s, _ := setup(t)
	for _, headers := range []map[string]string{{"Host": "evil.test"}, {"Origin": "https://evil.test"}, {"Sec-Fetch-Site": "cross-site"}, {"Origin": "https://localhost"}} {
		r := httptest.NewRequest("POST", "http://localhost/api/login", strings.NewReader(`{"token":"`+testToken+`"}`))
		for k, v := range headers {
			if k == "Host" {
				r.Host = v
			} else {
				r.Header.Set(k, v)
			}
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("accepted %+v", headers)
		}
	}
	r := httptest.NewRequest("POST", "http://localhost/api/login", strings.NewReader(`{"token":"`+testToken+`"}`))
	r.RemoteAddr = "127.0.0.1:9000"
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("Origin", "https://localhost")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 || !w.Result().Cookies()[0].Secure {
		t.Fatal("HTTPS proxy cookie")
	}
}
func TestRateLimitLogoutAndStatic(t *testing.T) {
	s, _ := setup(t)
	c := loginCookie(t, s)
	w := request(s, "POST", "/api/logout", "{}", c)
	if w.Code != 200 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout")
	}
	for i := 0; i < 20; i++ {
		request(s, "POST", "/api/login", `{}`, nil)
	}
	if w := request(s, "POST", "/api/login", `{}`, nil); w.Code != 429 {
		t.Fatal("no rate limit")
	}
	for _, path := range []string{"/", "/app.js", "/style.css"} {
		if w := request(s, "GET", path, "", nil); w.Code != 200 {
			t.Fatalf("static %s %d", path, w.Code)
		}
	}
	if w := request(s, "GET", "/server.go", "", nil); w.Code != 404 {
		t.Fatal("source exposed")
	}
}
func TestSSEChangeAndDisconnect(t *testing.T) {
	s, path := setup(t)
	cookie := loginCookie(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	ts := httptest.NewServer(s)
	defer ts.Close()
	streamCtx, closeStream := context.WithTimeout(context.Background(), 6*time.Second)
	defer closeStream()
	r, _ := http.NewRequestWithContext(streamCtx, "GET", ts.URL+"/api/events", nil)
	r.AddCookie(cookie)
	res, e := ts.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	reader := bufio.NewReader(res.Body)
	readData := func() string {
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				t.Fatal(e)
			}
			if strings.HasPrefix(line, "data:") {
				return line
			}
		}
	}
	first := readData()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	io.WriteString(f, "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"new\"}]}}\n")
	f.Close()
	if next := readData(); first == next {
		t.Fatal("no change notification")
	}
	closeStream()
	res.Body.Close()
	deadline := time.Now().Add(time.Second)
	for s.clients.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if s.clients.Load() != 0 {
		t.Fatal("subscriber leaked")
	}
}

func (testSender) Start(context.Context, string, string, string) desktop.Result {
	return desktop.Result{Status: "accepted"}
}

type testCreator struct{}

func (testCreator) Create(context.Context, string, string) (string, error) {
	return "11111111-2222-4333-8444-555555555555", nil
}
func TestQueueAndCreateBoundaries(t *testing.T) {
	s, path := setup(t)
	cookie := loginCookie(t, s)
	outbox, err := delivery.Open(filepath.Join(t.TempDir(), "outbox"), testSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer outbox.Close()
	s.cfg.Delivery = outbox
	s.cfg.Creator = testCreator{}
	body := `{"id":"queue-test-000001","threadId":"test","text":"later","mode":"queue"}`
	if w := request(s, "POST", "/api/send", body, nil); w.Code != 401 {
		t.Fatal("unauth queue", w.Code)
	}
	if w := request(s, "POST", "/api/send", body, cookie); w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(s, "POST", "/api/queue/cancel", `{"id":"queue-test-000001"}`, nil); w.Code != 401 {
		t.Fatal("unauth cancel")
	}
	if w := request(s, "POST", "/api/queue/cancel", `{"id":"queue-test-000001"}`, cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/send", strings.Replace(body, `"queue"`, `"raw-rpc"`, 1), cookie); w.Code != 409 {
		t.Fatal("invalid mode")
	}
	create := `{"id":"create-test-00001","projectPath":"/","text":"first"}`
	if w := request(s, "POST", "/api/thread/create", create, cookie); w.Code != 403 {
		t.Fatal("arbitrary path allowed")
	}
	project := filepath.Dir(path)
	record, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{"id": "test", "cwd": project}})
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.Write(append(record, '\n'))
	f.Close()
	s.store.Refresh(true)
	db := testutil.Desktop(t, filepath.Dir(filepath.Dir(path)))
	testutil.Exec(t, db, `INSERT INTO projects(id,name,position) VALUES ('test-project','Test',0)`)
	testutil.Exec(t, db, `INSERT INTO project_roots(project_id,path,position) VALUES ('test-project',?,0)`, project)
	s.store.Refresh(true)
	bytes, _ := json.Marshal(map[string]string{"id": "create-test-00001", "projectPath": project, "text": "first"})
	if w := request(s, "POST", "/api/thread/create", string(bytes), cookie); w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestDeliverySSEDoesNotWaitForPollingInterval(t *testing.T) {
	s, _ := setup(t)
	s.cfg.Interval = time.Minute
	out, err := delivery.Open(filepath.Join(t.TempDir(), "outbox"), testSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	s.cfg.Delivery = out
	cookie := loginCookie(t, s)
	ts := httptest.NewServer(s)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	req.AddCookie(cookie)
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	data := func() string {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(line, "data:") {
				return line
			}
		}
	}
	first := data()
	if _, err = out.Submit("immediate-sse-queue-01", "test", "hello", "queue"); err != nil {
		t.Fatal(err)
	}
	if next := data(); next == first {
		t.Fatal("receipt notification missing")
	}
}
