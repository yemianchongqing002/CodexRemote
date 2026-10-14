package chat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func line(typ string, p any) string {
	b, _ := json.Marshal(map[string]any{"timestamp": "2026-09-08T10:00:00Z", "type": typ, "payload": p})
	return string(b) + "\n"
}
func meta(id string) string {
	return line("session_meta", map[string]any{"id": id, "originator": "Codex Desktop", "cwd": "/projects/example"})
}
func canonical(id, role, text string) string {
	return line("event_msg", map[string]any{"type": "item_completed", "item": map[string]any{"id": id, "type": role, "content": []any{map[string]string{"type": "Text", "text": text}}}})
}
func legacy(id, role, text string) string {
	return line("response_item", map[string]any{"id": id, "type": "message", "role": role, "content": []any{map[string]string{"type": "output_text", "text": text}}})
}
func fixture(t *testing.T, content string) (*Store, string) {
	t.Helper()
	home := t.TempDir()
	p := filepath.Join(home, "sessions", "2026", "log.jsonl")
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(p, []byte(content), 0600); e != nil {
		t.Fatal(e)
	}
	s, e := New(home)
	if e != nil {
		t.Fatal(e)
	}
	s.Refresh(true)
	return s, p
}
func appendFile(t *testing.T, p, v string) {
	t.Helper()
	f, e := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.WriteString(v); e != nil {
		t.Fatal(e)
	}
	f.Close()
}

func TestTurnSettingsIncrementalSync(t *testing.T) {
	s, path := fixture(t, meta("thread"))
	before, _ := s.Read("thread", "", "", 50)
	if before.Thread.LastTurnSettings != nil {
		t.Fatal("invented model settings")
	}
	appendFile(t, path, line("turn_context", map[string]any{"model": "gpt-6-astra", "effort": "medium"}))
	s.RefreshThread("thread")
	first, _ := s.Read("thread", "", before.Cursor, 50)
	if first.Thread.LastTurnSettings == nil || first.Thread.LastTurnSettings.Model != "gpt-6-astra" || first.Thread.LastTurnSettings.Effort != "medium" || first.Thread.Version == before.Thread.Version {
		t.Fatalf("settings did not sync: %+v", first.Thread)
	}
	appendFile(t, path, line("turn_context", map[string]any{"model": "another-model"}))
	s.RefreshThread("thread")
	next, _ := s.Read("thread", "", first.Cursor, 50)
	if next.Thread.LastTurnSettings.Model != "another-model" || next.Thread.LastTurnSettings.Effort != "" || next.Thread.Version == first.Thread.Version || len(next.Messages) != 0 {
		t.Fatalf("model-only update failed: %+v", next)
	}
	if first.Thread.LastTurnSettings.Model != "gpt-6-astra" {
		t.Fatal("previous snapshot mutated")
	}
	appendFile(t, path, line("turn_context", map[string]any{}))
	s.RefreshThread("thread")
	last, _ := s.Read("thread", "", "", 50)
	if last.Thread.LastTurnSettings != nil {
		t.Fatal("stale settings retained")
	}
}

func TestDesktopCanonicalAndMirrors(t *testing.T) {
	s, _ := fixture(t, meta("thread")+legacy("u", "user", "question")+canonical("u", "UserMessage", "question")+legacy("a", "assistant", "answer")+canonical("a", "AgentMessage", "answer")+canonical("a", "AgentMessage", "answer"))
	p, ok := s.Read("thread", "", "", 50)
	if !ok || len(p.Messages) != 2 || p.Messages[0].Role != "user" || p.Messages[1].Text != "answer" {
		t.Fatalf("bad canonical messages: %+v", p)
	}
	if p.Thread.Source != "Codex Desktop" {
		t.Fatal(p.Thread.Source)
	}
}
func TestPartialLineAndIncrementalCursor(t *testing.T) {
	s, path := fixture(t, meta("thread")+canonical("1", "UserMessage", "first"))
	p, _ := s.Read("thread", "", "", 50)
	v := s.Version()
	next := canonical("2", "AgentMessage", "second")
	appendFile(t, path, next[:len(next)/2])
	s.Refresh(false)
	if s.Version() != v {
		t.Fatal("incomplete record changed visible data")
	}
	appendFile(t, path, next[len(next)/2:])
	s.Refresh(false)
	delta, _ := s.Read("thread", "", p.Cursor, 50)
	if delta.Reset || len(delta.Messages) != 1 || delta.Messages[0].Text != "second" {
		t.Fatalf("bad delta: %+v", delta)
	}
	s.Refresh(false)
	empty, _ := s.Read("thread", "", delta.Cursor, 50)
	if len(empty.Messages) != 0 {
		t.Fatal("replayed messages")
	}
}
func TestTruncationResetsCursor(t *testing.T) {
	s, path := fixture(t, meta("thread")+canonical("1", "UserMessage", strings.Repeat("x", 500)))
	old, _ := s.Read("thread", "", "", 50)
	if e := os.WriteFile(path, []byte(meta("thread")+canonical("2", "UserMessage", "new")), 0600); e != nil {
		t.Fatal(e)
	}
	s.Refresh(false)
	p, _ := s.Read("thread", "", old.Cursor, 50)
	if !p.Reset || len(p.Messages) != 1 || p.Messages[0].Text != "new" {
		t.Fatalf("reset failed %+v", p)
	}
}
func TestPaginationAndRetention(t *testing.T) {
	var b strings.Builder
	b.WriteString(meta("thread"))
	for i := 0; i < 550; i++ {
		b.WriteString(canonical(fmt.Sprint(i), "AgentMessage", fmt.Sprint(i)))
	}
	s, _ := fixture(t, b.String())
	latest, _ := s.Read("thread", "", "", 50)
	if len(latest.Messages) != 50 || latest.Messages[0].Text != "500" || !latest.Thread.Limited || latest.Thread.Count != 500 {
		t.Fatalf("bad page %+v", latest.Thread)
	}
	older, _ := s.Read("thread", latest.Before, "", 50)
	if older.Messages[0].Text != "450" {
		t.Fatal("older pagination")
	}
	f := s.files
	var gen string
	for _, v := range f {
		gen = v.generation
	}
	stale, _ := s.Read("thread", "", gen+".1", 50)
	if !stale.Reset {
		t.Fatal("evicted cursor must reset")
	}
}
func TestLegacyFiltersAndMalformed(t *testing.T) {
	content := meta("thread") + "{broken}\n" + legacy("s", "system", "hidden") + legacy("d", "developer", "hidden") + legacy("u", "user", "visible")
	content += line("response_item", map[string]any{"type": "message", "role": "user", "internal_chat_message_metadata_passthrough": map[string]any{"content_item_kinds": []string{"environments.environment_context"}}, "content": []any{map[string]string{"type": "input_text", "text": "hidden environment"}}})
	content += line("response_item", map[string]any{"type": "message", "role": "assistant", "phase": "analysis", "content": []any{map[string]string{"type": "output_text", "text": "hidden reasoning"}}})
	s, _ := fixture(t, content)
	p, _ := s.Read("thread", "", "", 50)
	if len(p.Messages) != 1 || p.Messages[0].Text != "visible" {
		t.Fatal("leaked scaffold")
	}
}
func TestArchiveAndSymlink(t *testing.T) {
	s, path := fixture(t, meta("thread")+canonical("u", "UserMessage", "hello"))
	archive := filepath.Join(s.home, "archived_sessions")
	os.MkdirAll(archive, 0700)
	if e := os.Rename(path, filepath.Join(archive, "old.jsonl")); e != nil {
		t.Fatal(e)
	}
	external := filepath.Join(t.TempDir(), "outside.jsonl")
	os.WriteFile(external, []byte(meta("secret")), 0600)
	os.Symlink(external, path)
	s.Refresh(true)
	page, ok := s.Read("thread", "", "", 50)
	if !ok || !page.Thread.Archived {
		t.Fatalf("archive %+v", page)
	}
	if _, exists := s.Read("secret", "", "", 50); exists {
		t.Fatal("followed external symlink")
	}
}
func TestLargeLineSkipped(t *testing.T) {
	s, path := fixture(t, meta("thread"))
	appendFile(t, path, strings.Repeat("x", maxLine+100)+"\n"+canonical("u", "UserMessage", "actual message"))
	s.Refresh(false)
	p, _ := s.Read("thread", "", "", 50)
	if len(p.Messages) != 1 || !p.Thread.Limited {
		t.Fatalf("large line %+v", p)
	}
}
func TestStatusAndNoChange(t *testing.T) {
	s, path := fixture(t, meta("thread")+line("event_msg", map[string]string{"type": "task_started"}))
	v := s.Version()
	s.Refresh(false)
	if v != s.Version() {
		t.Fatal("idle refresh changed version")
	}
	appendFile(t, path, line("event_msg", map[string]string{"type": "task_complete"}))
	s.Refresh(false)
	page, _ := s.Read("thread", "", "", 50)
	if page.Thread.Status != "idle" {
		t.Fatal("completion not reflected")
	}
}

func TestGlobalBudgetIncludesPartialRecords(t *testing.T) {
	s := &Store{files: map[string]*fileState{}}
	for i := 0; i < 20; i++ {
		f := fresh(fmt.Sprint(i), false)
		f.pending = make([]byte, maxLine)
		s.files[fmt.Sprint(i)] = f
	}
	s.trimBudget()
	total := 0
	for _, f := range s.files {
		total += f.bytes + len(f.pending)
	}
	if total > maxTotalBytes {
		t.Fatalf("pending records exceeded budget: %d", total)
	}
}

func TestQueueReadinessAndImportedInitialMessage(t *testing.T) {
	initial := line("response_item", map[string]any{"type": "message", "id": "codex-remote-initial-test", "role": "user", "content": []any{map[string]string{"type": "input_text", "text": "first request"}}})
	s, path := fixture(t, meta("thread")+initial+line("event_msg", map[string]string{"type": "task_started"}))
	if ready, _ := s.QueueReady("thread"); ready {
		t.Fatal("active")
	}
	appendFile(t, path, canonical("answer", "AgentMessage", "reply")+line("event_msg", map[string]string{"type": "task_complete"}))
	s.Refresh(true)
	if ready, _ := s.QueueReady("thread"); !ready {
		t.Fatal("completed")
	}
	page, _ := s.Read("thread", "", "", 50)
	if len(page.Messages) != 2 || page.Messages[0].Text != "first request" {
		t.Fatal("initial message lost", page.Messages)
	}
	appendFile(t, path, `{"type":`)
	if ready, _ := s.QueueReady("thread"); ready {
		t.Fatal("unread data")
	}
	s.Refresh(true)
	if ready, _ := s.QueueReady("thread"); ready {
		t.Fatal("partial line")
	}
}

func TestRefreshThreadReadsOnlyTarget(t *testing.T) {
	s, p := fixture(t, meta("target")+canonical("u", "UserMessage", "first"))
	other := filepath.Join(filepath.Dir(p), "other.jsonl")
	os.WriteFile(other, []byte(meta("other")+canonical("v", "UserMessage", "other")), 0600)
	s.Refresh(true)
	appendFile(t, p, canonical("a", "AgentMessage", "target update"))
	appendFile(t, other, canonical("b", "AgentMessage", "other update"))
	s.RefreshThread("target")
	a, _ := s.Read("target", "", "", 50)
	b, _ := s.Read("other", "", "", 50)
	if len(a.Messages) != 2 || len(b.Messages) != 1 {
		t.Fatal("targeted read touched another rollout")
	}
}

func TestQueueReadyAfterUserStop(t *testing.T) {
	for _, event := range []string{"task_aborted", "turn_aborted"} {
		t.Run(event, func(t *testing.T) {
			s, path := fixture(t, meta("thread")+line("event_msg", map[string]string{"type": "task_started", "turn_id": "first"}))
			if ready, _ := s.QueueReady("thread"); ready {
				t.Fatal("running turn is ready")
			}
			appendFile(t, path, line("event_msg", map[string]string{"type": event, "turn_id": "first"}))
			if ready, _ := s.QueueReady("thread"); ready {
				t.Fatal("unread stop is ready")
			}
			s.RefreshThread("thread")
			ready, version := s.QueueReady("thread")
			if !ready || version == "" {
				t.Fatal("confirmed stop must allow a new turn")
			}
			s.RefreshThread("thread")
			if ready, next := s.QueueReady("thread"); !ready || next != version {
				t.Fatal("stop readiness must remain stable")
			}
			appendFile(t, path, line("event_msg", map[string]string{"type": "task_started", "turn_id": "second"}))
			if ready, _ := s.QueueReady("thread"); ready {
				t.Fatal("unread next turn must block dispatch")
			}
			s.RefreshThread("thread")
			if ready, _ := s.QueueReady("thread"); ready {
				t.Fatal("next active turn must block dispatch")
			}
		})
	}
}
