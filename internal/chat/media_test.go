package chat

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalImageInputBlock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "uploaded.png")
	raw, err := json.Marshal([]map[string]string{{"type": "localImage", "path": path}})
	if err != nil {
		t.Fatal(err)
	}
	if text := textBlocks(raw); !strings.Contains(text, path) {
		t.Fatal("localImage path missing", text)
	}
}

func TestImageAttachmentsAndReferences(t *testing.T) {
	image := filepath.Join(t.TempDir(), "a photo.png")
	raw, err := json.Marshal([]map[string]any{{"type": "input_image", "image_url": image}, {"type": "image_url", "image_url": map[string]string{"url": "https://example.com/p.png"}}, {"type": "input_image", "image_url": "data:image/png;base64,AA"}})
	if err != nil {
		t.Fatal(err)
	}
	text := textBlocks(raw)
	s, _ := fixture(t, meta("t")+legacy("m", "assistant", text))
	if path, ok := s.MediaPath("t", "m", image); !ok || path != image {
		t.Fatal(path, ok)
	}
	for _, v := range []struct{ thread, message, path string }{{"wrong", "m", "/tmp/a photo.png"}, {"t", "wrong", "/tmp/a photo.png"}, {"t", "m", "/tmp/secret.png"}, {"t", "m", "https://example.com/p.png"}} {
		if _, ok := s.MediaPath(v.thread, v.message, v.path); ok {
			t.Fatal(v)
		}
	}
	if len(text) > 300 {
		t.Fatal("embedded bytes retained")
	}
}

func TestRejectNetworkAndDeviceMedia(t *testing.T) {
	for _, reference := range []string{`\\server\share\image.png`, `\\?\C:\image.png`, `\\.\C:\image.png`, `//server/share/image.png`, `/\server\share\image.png`, `C:relative.png`} {
		t.Run(reference, func(t *testing.T) {
			s, _ := fixture(t, meta("t")+legacy("m", "assistant", "![image](<"+reference+">)"))
			if path, ok := s.MediaPath("t", "m", reference); ok {
				t.Fatalf("accepted non-local or ambiguous reference: %q", path)
			}
		})
	}
}
