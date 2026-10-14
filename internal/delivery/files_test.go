package delivery

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileAttachmentStorageAndInput(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), &imageTestSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	data := []byte("uploaded document content")
	id, err := s.SaveFile("../../report.txt", data)
	if err != nil {
		t.Fatal(err)
	}
	path, err := s.ImagePath(id)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatal("file bytes changed", err)
	}
	text, images, err := s.attachmentInput("read this", []string{id})
	if err != nil || len(images) != 0 || !strings.Contains(text, filepath.Base(path)) || !strings.HasPrefix(text, "read this") {
		t.Fatal("file was not delivered as local path", text, images, err)
	}
	if _, err = s.SaveFile("empty.txt", nil); err == nil {
		t.Fatal("empty file accepted")
	}
	if _, err = s.ImagePath("../outside.file.txt"); err == nil {
		t.Fatal("path traversal accepted")
	}
	if err = os.WriteFile(path, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.attachmentInput("", []string{id}); err == nil {
		t.Fatal("tampered file accepted")
	}
}
