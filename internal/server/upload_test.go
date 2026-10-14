package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"path/filepath"
	"testing"

	"codexremote/internal/delivery"
)

func TestImageUploadAuthenticationAndPreview(t *testing.T) {
	s, _ := setup(t)
	cookie := loginCookie(t, s)
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	if w := request(s, "POST", "/api/upload-image", data.String(), cookie); w.Code != 403 {
		t.Fatal("read-only upload", w.Code)
	}
	out, err := delivery.Open(filepath.Join(t.TempDir(), "outbox"), testSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	s.cfg.Delivery = out
	if w := request(s, "POST", "/api/upload-image", data.String(), nil); w.Code != 401 {
		t.Fatal("anonymous upload", w.Code)
	}
	w := request(s, "POST", "/api/upload-image", data.String(), cookie)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	url := "/api/upload-image?id=" + result.ID
	if w := request(s, "GET", url, "", nil); w.Code != 401 {
		t.Fatal("anonymous image read", w.Code)
	}
	if w := request(s, "GET", url, "", cookie); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data.Bytes()) {
		t.Fatal("preview mismatch", w.Code)
	}
	if w := request(s, "POST", "/api/upload-image", "<svg></svg>", cookie); w.Code != 400 {
		t.Fatal("invalid image accepted", w.Code)
	}
}
