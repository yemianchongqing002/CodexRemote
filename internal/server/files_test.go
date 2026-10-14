package server

import (
	"codexremote/internal/delivery"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestFileUploadAuthorization(t *testing.T) {
	s, _ := setup(t)
	cookie := loginCookie(t, s)
	const endpoint = "/api/upload-file?name=report.txt"
	if w := request(s, "POST", endpoint, "content", cookie); w.Code != 403 {
		t.Fatal(w.Code)
	}
	out, err := delivery.Open(filepath.Join(t.TempDir(), "outbox"), testSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	s.cfg.Delivery = out
	if w := request(s, "POST", endpoint, "content", nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w := request(s, "POST", endpoint, "content", cookie)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if _, err = out.ImagePath(result.ID); err != nil {
		t.Fatal(err)
	}
	if w = request(s, "GET", "/api/upload-image?id="+result.ID, "", cookie); w.Code != 404 {
		t.Fatal("file served inline", w.Code)
	}
}
