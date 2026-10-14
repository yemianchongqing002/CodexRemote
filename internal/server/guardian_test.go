package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGuardianRestartUsesServiceAuthentication(t *testing.T) {
	called := 0
	s := New(nil, Config{Token: strings.Repeat("a", 48), AllowedHosts: []string{"machine"}, RestartService: func(context.Context) error { called++; return nil }})
	r := httptest.NewRequest("POST", "http://machine/api/guardian/restart", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 || called != 0 {
		t.Fatal("restart bypassed login")
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("POST", "http://machine/api/login", strings.NewReader(`{"token":"`+strings.Repeat("a", 48)+`"}`)))
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing login cookie")
	}
	r = httptest.NewRequest("POST", "http://machine/api/guardian/restart", nil)
	r.AddCookie(cookies[0])
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusAccepted || called != 1 {
		t.Fatal("valid restart not routed")
	}
	r = httptest.NewRequest("POST", "http://machine/api/guardian/restart", nil)
	r.AddCookie(cookies[0])
	r.Header.Set("Origin", "http://evil")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 || called != 1 {
		t.Fatal("cross-origin restart accepted")
	}
}
