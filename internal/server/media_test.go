package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestMediaScopeTypeAndRange(t *testing.T) {
	s, log := setup(t)
	root := t.TempDir()
	image := filepath.Join(root, "a photo.gif")
	secret := filepath.Join(root, "private.gif")
	fake := filepath.Join(root, "fake.png")
	os.WriteFile(image, []byte("GIF89a1234567890"), 0600)
	os.WriteFile(secret, []byte("GIF89asecret"), 0600)
	os.WriteFile(fake, []byte("<html>secret</html>"), 0600)
	record := map[string]any{"type": "response_item", "payload": map[string]any{"id": "media-message", "type": "message", "role": "assistant", "content": []any{map[string]string{"type": "output_text", "text": "![photo](<" + image + ">) ![bad](" + fake + ")"}}}}
	data, _ := json.Marshal(record)
	f, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0600)
	f.Write(append(data, '\n'))
	f.Close()
	s.store.Refresh(true)
	cookie := loginCookie(t, s)
	endpoint := func(message, path string) string {
		return "/api/media?" + url.Values{"thread": {"test"}, "message": {message}, "path": {path}}.Encode()
	}
	if w := request(s, "GET", endpoint("media-message", image), "", nil); w.Code != 401 {
		t.Fatal("unauthenticated media", w.Code)
	}
	if w := request(s, "GET", endpoint("media-message", secret), "", cookie); w.Code != 404 {
		t.Fatal("unreferenced file", w.Code)
	}
	if w := request(s, "GET", endpoint("wrong", image), "", cookie); w.Code != 404 {
		t.Fatal("wrong message", w.Code)
	}
	if w := request(s, "GET", endpoint("media-message", fake), "", cookie); w.Code != 415 {
		t.Fatal("fake image", w.Code)
	}
	r := httptest.NewRequest("GET", "http://localhost"+endpoint("media-message", image), nil)
	r.AddCookie(cookie)
	r.Header.Set("Range", "bytes=0-5")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "GIF89a" || w.Header().Get("Content-Type") != "image/gif" {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
}
