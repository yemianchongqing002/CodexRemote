package delivery

import (
	"codexremote/internal/desktop"
	"context"
	"path/filepath"
	"testing"
)

type configuredSender struct{ queueSender }

func (*configuredSender) StartWithSettings(context.Context, string, string, string, []string, *desktop.ModelSettings) desktop.Result {
	return desktop.Result{Status: "accepted"}
}
func TestQueuedSettingsPersistAndBindRequest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox")
	sender := &configuredSender{}
	s, err := Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	settings := &desktop.ModelSettings{Model: "example", Effort: "high", Fast: true}
	id := "settings-request-001"
	if _, err = s.SubmitWithSettings(id, "thread", "hello", nil, settings, "queue"); err != nil {
		t.Fatal(err)
	}
	settings.Fast = false
	if _, err = s.SubmitWithSettings(id, "thread", "hello", nil, settings, "queue"); err != ErrConflict {
		t.Fatal("changed settings did not conflict", err)
	}
	s.Close()
	s, err = Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, ok := s.Get(id)
	if !ok || e.ModelSettings == nil || !e.ModelSettings.Fast || e.Status != "queued" {
		t.Fatal(e)
	}
}

func TestPromoteSettingsUsesCurrentTurnAndKeepsReceipt(t *testing.T) {
	sender := &configuredSender{}
	path := filepath.Join(t.TempDir(), "outbox")
	s, err := Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	id := "settings-promote-001"
	settings := &desktop.ModelSettings{Model: "next-model", Effort: "high", Fast: true}
	original, err := s.SubmitWithSettings(id, "thread", "guide now", nil, settings, "queue")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Promote(id); err != nil {
		t.Fatal(err)
	}
	waitEntry(t, s, id)
	if _, err = s.Promote(id); err != nil {
		t.Fatal(err)
	}
	if sender.steers.Load() != 1 || sender.starts.Load() != 0 {
		t.Fatal("promotion did not steer exactly once")
	}
	s.Close()
	s, err = Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	entry, ok := s.Get(id)
	if !ok || entry.Digest != original.Digest || entry.ModelSettings == nil || entry.ModelSettings.Model != "next-model" {
		t.Fatal("lost original request metadata", entry)
	}
}
