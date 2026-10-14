package server

import (
	"codexremote/internal/platform"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestReleaseBeforeAuthAndNetworkBoundary(t *testing.T) {
	s, _ := setup(t)
	w := request(s, "GET", "/api/version", "", nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["adapter"] != "desktop-rollout" || body["release"].(map[string]any)["serverVersion"] != ServerVersion {
		t.Fatal(body)
	}
	for _, key := range []string{"connectionName", "hostName", "version", "sendingEnabled"} {
		if _, ok := body[key]; ok {
			t.Fatal("private metadata exposed", key)
		}
	}
	if request(s, "GET", "/api/status", "", nil).Code != 401 {
		t.Fatal("status authorization lost")
	}
	r := httptest.NewRequest("GET", "http://evil.test/api/version", nil)
	out := httptest.NewRecorder()
	s.ServeHTTP(out, r)
	if out.Code != 403 {
		t.Fatal("host boundary lost", out.Code)
	}
	if request(s, "POST", "/api/version", "", nil).Code != 405 {
		t.Fatal("method boundary lost")
	}
	s.cfg.NoAuth = true
	w = request(s, "GET", "/api/status", "", nil)
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["connectionName"] != platform.ComputerName() || body["hostName"] != body["connectionName"] {
		t.Fatalf("computer name mismatch: %v", body)
	}
	if _, ok := body["version"]; !ok {
		t.Fatal("chat revision removed")
	}
	if body["release"].(map[string]any)["serverVersion"] != ServerVersion {
		t.Fatal(body)
	}
}
