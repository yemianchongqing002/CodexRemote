package server

import "testing"

func TestModelSettingsRequireLoginAndWriteMode(t *testing.T) {
	s, _ := setup(t)
	cookie := loginCookie(t, s)
	for _, route := range []struct{ method, path string }{{"GET", "/api/models"}, {"POST", "/api/thread/interrupt"}} {
		if w := request(s, route.method, route.path, "{}", nil); w.Code != 401 {
			t.Fatal("unauthenticated models", w.Code)
		}
		if w := request(s, route.method, route.path, "{}", cookie); w.Code != 403 {
			t.Fatal("readonly models", w.Code)
		}
	}
}
