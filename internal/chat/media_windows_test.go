package chat

import (
	"path/filepath"
	"testing"
)

func TestWindowsDriveMedia(t *testing.T) {
	for _, reference := range []string{`C:\Users\测试\a photo.png`, `C:/Users/测试/a photo.png`} {
		s, _ := fixture(t, meta("t")+legacy("m", "assistant", "![image](<"+reference+">)"))
		if path, ok := s.MediaPath("t", "m", reference); !ok || path != filepath.Clean(reference) {
			t.Fatalf("drive reference %q: %q, %v", reference, path, ok)
		}
	}
}
