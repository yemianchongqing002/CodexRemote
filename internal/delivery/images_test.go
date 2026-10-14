package delivery

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"codexremote/internal/desktop"
)

type imageTestSender struct {
	queueSender
	paths chan []string
}

func (s *imageTestSender) SendImages(_ context.Context, _, _, _ string, paths []string) desktop.Result {
	s.paths <- paths
	return desktop.Result{Status: "accepted", TurnID: "image-turn"}
}
func (s *imageTestSender) StartImages(ctx context.Context, thread, id, text string, paths []string) desktop.Result {
	return s.SendImages(ctx, thread, id, text, paths)
}

func TestImageQueueRestoreAndIntegrity(t *testing.T) {
	sender := &imageTestSender{paths: make(chan []string, 1)}
	path := filepath.Join(t.TempDir(), "outbox")
	s, err := Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	id, err := s.SaveImage(data.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if again, err := s.SaveImage(data.Bytes()); err != nil || again != id {
		t.Fatal("duplicate image not reused", err)
	}
	if _, err := s.SaveImage([]byte("<svg></svg>")); err == nil {
		t.Fatal("non-raster accepted")
	}
	if _, err := s.ImagePath("../../secret.png"); err == nil {
		t.Fatal("path traversal accepted")
	}
	requestID := "image-request-0001"
	if _, err := s.SubmitImages(requestID, "thread", "", []string{id}, "queue"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SubmitImages(requestID, "thread", "different", []string{id}, "queue"); err != ErrConflict {
		t.Fatal("image request lost idempotency binding", err)
	}
	if _, err := s.SubmitImages("image-request-0002", "thread", "", []string{id, id, id, id, id}, "queue"); err == nil {
		t.Fatal("fifth image accepted")
	}
	s.Close()
	s, err = Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if view := s.QueueStatus("thread"); len(view) != 1 || len(view[0].Images) != 1 || view[0].Images[0] != id {
		t.Fatal("image-only queue not restored", view)
	}
	ready := func(string) (bool, string) { return true, "complete" }
	s.checkQueue(ready)
	s.checkQueue(ready)
	if e := waitEntry(t, s, requestID); e.Status != "accepted" {
		t.Fatal(e)
	}
	paths := <-sender.paths
	if len(paths) != 1 || !filepath.IsAbs(paths[0]) {
		t.Fatal(paths)
	}
	if err := os.WriteFile(paths[0], []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SubmitImages("image-request-0003", "thread", "", []string{id}, "queue"); err == nil {
		t.Fatal("corrupt attachment accepted")
	}
}
