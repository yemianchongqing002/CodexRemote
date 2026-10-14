package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (string, Config) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "guardian.json")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Version: 1, Executable: exe, Service: ServiceConfig{Listen: "127.0.0.1:8787", Home: dir, TokenFile: filepath.Join(dir, "token"), Interval: "3s", ReadOnly: true, CodexBinary: "codex", OpenCreated: true, OpenOnSend: true}}
	if err = prepare(path); err != nil {
		t.Fatal(err)
	}
	if err = writeJSON(path, cfg); err != nil {
		t.Fatal(err)
	}
	return path, cfg
}

func TestConfigOnlyContainsBusinessSettings(t *testing.T) {
	path, cfg := fixture(t)
	if _, err := Load(path); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	v["args"] = []string{"--supervise=true", "--guardian-role=B"}
	if err = writeJSON(path, v); err != nil {
		t.Fatal(err)
	}
	if _, err = Load(path); err == nil {
		t.Fatal("raw argv accepted")
	}
	if err = writeJSON(path, cfg); err != nil {
		t.Fatal(err)
	}
	cfg.Service.Name = "changed"
	if err = writeJSON(path, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil || loaded.Service.Name != "changed" {
		t.Fatal("config not reloaded", err)
	}
}

func TestDuplicateBootCannotOverwriteConfig(t *testing.T) {
	path, cfg := fixture(t)
	lock, err := takeLock(rolePath(path, "B"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	cfg.Service.Listen = "127.0.0.1:9999"
	if err = Boot(context.Background(), path, cfg); err == nil {
		t.Fatal("duplicate B boot accepted")
	}
	loaded, err := Load(path)
	if err != nil || loaded.Service.Listen != "127.0.0.1:8787" {
		t.Fatal("live configuration overwritten", err)
	}
}

func TestThreeFailuresAndResumeReset(t *testing.T) {
	d := detector{}
	now := time.Now()
	if d.observe(now, false) || d.observe(now.Add(30*time.Second), false) {
		t.Fatal("recovered too soon")
	}
	if !d.observe(now.Add(60*time.Second), false) {
		t.Fatal("third failure ignored")
	}
	if d.observe(now.Add(90*time.Second), true) {
		t.Fatal("success did not reset")
	}
	d.observe(now.Add(120*time.Second), false)
	d.observe(now.Add(150*time.Second), false)
	if d.observe(now.Add(10*time.Minute), false) {
		t.Fatal("resume reused failures from before sleep")
	}
}

func TestSessionFenceAndRoleLock(t *testing.T) {
	path, _ := fixture(t)
	s := session{ID: "session", Running: true}
	if err := writeJSON(statePath(path), s); err != nil {
		t.Fatal(err)
	}
	p, err := Join(context.Background(), path, "A", s.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.StartMonitor()
	defer p.Close()
	p.Ready(nil)
	if _, err = Join(context.Background(), path, "A", s.ID); err == nil {
		t.Fatal("duplicate role accepted")
	}
	if _, err = Join(context.Background(), path, "B", "stale"); err == nil {
		t.Fatal("stale session accepted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = markStopped(ctx, path, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = Join(context.Background(), path, "B", s.ID); err == nil {
		t.Fatal("stopped session revived")
	}
}

func TestLocalHealthChecksRoleInstanceAndMonitor(t *testing.T) {
	path, _ := fixture(t)
	s := session{ID: "session", Running: true}
	if err := writeJSON(statePath(path), s); err != nil {
		t.Fatal(err)
	}
	p, err := Join(context.Background(), path, "B", s.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.StartMonitor()
	defer p.Close()
	p.Ready(nil)
	r, err := loadRecord(path, "B")
	if err != nil {
		t.Fatal(err)
	}
	if v, e := exchange(context.Background(), path, r, "health"); e != nil || !v.Healthy {
		t.Fatal("healthy peer rejected", e)
	}
	bad := r
	bad.Instance = strings.Repeat("x", 48)
	if _, e := exchange(context.Background(), path, bad, "health"); e == nil {
		t.Fatal("incorrect instance accepted")
	}
	p.mu.Lock()
	p.lastTick = time.Now().Add(-2 * time.Minute)
	p.mu.Unlock()
	if v, e := exchange(context.Background(), path, r, "health"); e != nil || v.Healthy {
		t.Fatal("stalled monitor reported healthy", e)
	}
}
