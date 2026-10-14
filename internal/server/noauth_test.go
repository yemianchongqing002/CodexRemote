package server

import (
	"net/http/httptest"
	"testing"
)

func TestNoAuthKeepsNetworkAndReadOnlyBoundaries(t *testing.T) {
	s, _ := setup(t)
	s.cfg.NoAuth = true
	if w := request(s, "GET", "/api/status", "", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(s, "GET", "/api/threads", "", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/login", "{}", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/send", "{}", nil); w.Code != 403 {
		t.Fatal("readonly lost", w.Code)
	}
	for _, header := range []struct{ key, value string }{{"Origin", "http://evil.test"}, {"Sec-Fetch-Site", "cross-site"}} {
		r := httptest.NewRequest("GET", "http://localhost/api/status", nil)
		r.Header.Set(header.key, header.value)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("cross-site bypass", w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://evil.test/api/status", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("Host bypass", w.Code)
	}
	s.cfg.NoAuth = false
	if w := request(s, "GET", "/api/status", "", nil); w.Code != 401 {
		t.Fatal("token mode disabled", w.Code)
	}
}
