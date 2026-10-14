package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAutoLocalHostsRetainsOriginBoundary(t *testing.T) {
	for _, tc := range []struct {
		host, origin string
		auto         bool
		want         int
	}{
		{"127.0.0.1:8787", "", true, 204},
		{"100.64.10.12:8787", "", true, 204},
		{"100.64.10.12:8787", "http://100.64.10.12:8787", true, 204},
		{"100.64.10.12:8787", "http://evil.test", true, 403},
		{"evil.test", "", true, 403},
		{"100.64.10.13:8787", "", true, 403},
		{"100.64.10.12:8787", "", false, 403},
	} {
		s := &Server{cfg: Config{AutoLocalHosts: tc.auto}}
		r := httptest.NewRequest("GET", "http://"+tc.host+"/api/status", nil)
		r.Header.Set("Origin", tc.origin)
		r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.ParseIP("100.64.10.12")}))
		w := httptest.NewRecorder()
		s.boundary(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%+v: got %d", tc, w.Code)
		}
	}
}
