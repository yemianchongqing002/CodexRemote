package chat

import (
	"codexremote/internal/testutil"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func saveDesktopState(t *testing.T, home string, state any) {
	t.Helper()
	b, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(home, ".codex-global-state.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestSidebarUsesDesktopCatalog(t *testing.T) {
	home := t.TempDir()
	db := testutil.Desktop(t, home)
	project := filepath.Join(home, "project")
	os.Mkdir(project, 0700)
	state := map[string]any{
		"local-projects":                map[string]any{"p": map[string]any{"id": "p", "name": "正式项目名", "rootPaths": []string{project}}, "empty": map[string]any{"id": "empty", "name": "没有任务的项目", "rootPaths": []string{"/missing"}}},
		"project-order":                 []string{"empty", "p"},
		"projectless-thread-ids":        []string{"recent"},
		"thread-project-assignments":    map[string]any{"moved": map[string]string{"projectKind": "local", "projectId": "p"}},
		"electron-persisted-atom-state": map[string]any{"codex-writing-block-deleted-thread-v1:deleted": true},
	}
	saveDesktopState(t, home, state)
	testutil.Exec(t, db, `INSERT INTO threads(id,title,name,cwd,recency_at_ms,updated_at_ms) VALUES ('old','首条消息','改过的标题',?,1000,999999),('recent','独立任务',NULL,?,2000,2000),('moved','已移动任务',NULL,'/worktree/other',3000,3000)`, project, project)
	testutil.Exec(t, db, `INSERT INTO threads(id,title,thread_source) VALUES ('voice','Voice Chat Thread','voice_chat'),('guardian','内部审批','guardian_review'),('deleted','已删除','user'); INSERT INTO threads(id,title,archived) VALUES ('archived','归档任务',1)`)
	os.MkdirAll(filepath.Join(home, "sessions"), 0700)
	os.WriteFile(filepath.Join(home, "sessions", "orphan.jsonl"), []byte(`{"type":"session_meta","payload":{"id":"orphan","cwd":"/fake/project"}}`+"\n"), 0600)
	os.WriteFile(filepath.Join(home, "sessions", "old.jsonl"), []byte(`{"type":"session_meta","payload":{"id":"old","cwd":"/wrong"}}`+"\n"), 0600)
	s, err := New(home)
	if err != nil {
		t.Fatal(err)
	}
	s.Refresh(true)
	got := s.Sidebar()
	if got.Warning != "" {
		t.Fatal(got.Warning)
	}
	ids := []string{}
	for _, thread := range got.Threads {
		ids = append(ids, thread.ID)
	}
	if !reflect.DeepEqual(ids, []string{"moved", "recent", "old", "archived"}) {
		t.Fatal(ids)
	}
	if got.Projects[0].ID != "empty" || got.Projects[0].Available || got.Projects[1].Name != "正式项目名" || !got.Projects[1].Available {
		t.Fatal(got.Projects)
	}
	if got.Threads[0].ProjectID != "p" || got.Threads[1].ProjectID != "" || got.Threads[2].ProjectID != "p" || got.Threads[2].Title != "改过的标题" || !got.Threads[3].Archived {
		t.Fatal(got.Threads)
	}
	page, ok := s.Read("old", "", "", 10)
	if !ok || page.Thread.Title != "改过的标题" || page.Thread.ProjectID != "p" {
		t.Fatal(page, ok)
	}
	// WAL updates to titles/archiving must be visible without rollout changes.
	version := got.Version
	testutil.Exec(t, db, `UPDATE threads SET name='新的标题',archived=1 WHERE id='old'`)
	s.Refresh(false)
	if next := s.Sidebar(); next.Version == version || next.Threads[2].Title != "新的标题" || !next.Threads[2].Archived {
		t.Fatal(next)
	}
	version = s.Sidebar().Version
	state["project-order"] = []string{"p", "empty"}
	saveDesktopState(t, home, state)
	s.Refresh(false)
	if next := s.Sidebar(); next.Version == version || next.Projects[0].ID != "p" {
		t.Fatal(next)
	}
	var n int
	if err = db.QueryRow(`SELECT count(*) FROM threads`).Scan(&n); err != nil || n != 7 {
		t.Fatal("reader changed desktop catalog", n, err)
	}
}

func TestSidebarMissingOrInvalidMetadataDoesNotInventProjects(t *testing.T) {
	home := t.TempDir()
	os.Mkdir(filepath.Join(home, "sessions"), 0700)
	os.WriteFile(filepath.Join(home, "sessions", "log.jsonl"), []byte(`{"type":"session_meta","payload":{"id":"task","cwd":"/wo"}}`+"\n"), 0600)
	s, _ := New(home)
	s.Refresh(true)
	got := s.Sidebar()
	if len(got.Threads) != 0 || len(got.Projects) != 0 || got.Warning == "" {
		t.Fatal(got)
	}
	if _, err := os.Stat(filepath.Join(home, "state_5.sqlite")); !os.IsNotExist(err) {
		t.Fatal("created desktop database")
	}
	testutil.Desktop(t, home)
	os.WriteFile(filepath.Join(home, ".codex-global-state.json"), []byte("{"), 0600)
	s.Refresh(false)
	if got = s.Sidebar(); got.Warning == "" || len(got.Threads) != 0 {
		t.Fatal(got)
	}
}

func TestNewThreadEmptyDesktopTitleMatchesDesktopPlaceholder(t *testing.T) {
	home := t.TempDir()
	db := testutil.Desktop(t, home)
	saveDesktopState(t, home, map[string]any{})
	testutil.Exec(t, db, `INSERT INTO threads(id,title) VALUES ('new',''),('empty','')`)
	os.MkdirAll(filepath.Join(home, "sessions"), 0700)
	content := `{"type":"session_meta","payload":{"id":"new","cwd":"/project"}}
{"type":"response_item","payload":{"type":"message","role":"user","id":"first","content":[{"type":"input_text","text":"新的会话测试"}]}}
`
	if err := os.WriteFile(filepath.Join(home, "sessions", "new.jsonl"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(home)
	if err != nil {
		t.Fatal(err)
	}
	s.Refresh(true)
	titles := map[string]string{}
	for _, thread := range s.Sidebar().Threads {
		titles[thread.ID] = thread.Title
	}
	if titles["new"] != "新聊天" || titles["empty"] != "新聊天" {
		t.Fatal(titles)
	}
	page, ok := s.Read("new", "", "", 10)
	if !ok || page.Thread.Title != "新聊天" {
		t.Fatal(page, ok)
	}
	version := s.Sidebar().Version
	testutil.Exec(t, db, `UPDATE threads SET name='正式标题' WHERE id='new'`)
	s.Refresh(false)
	if s.Sidebar().Version == version {
		t.Fatal("title change did not update sidebar version")
	}
	page, ok = s.Read("new", "", "", 10)
	if !ok || page.Thread.Title != "正式标题" {
		t.Fatal(page, ok)
	}
}

// Provider switches must not hide entries, including on older desktop schemas.
func TestSidebarLegacySchemaAndCustomProvider(t *testing.T) {
	home := t.TempDir()
	db := testutil.Desktop(t, home)
	testutil.Exec(t, db, `DROP TABLE projects; DROP TABLE project_roots; DROP TABLE thread_sections; DROP TABLE threads;
 CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,updated_at INTEGER,source TEXT,model_provider TEXT);
 INSERT INTO threads VALUES ('custom','第三方聊天','/saved',0,20,'vscode','custom'),('official','官方聊天','/saved',0,10,'cli','openai'),('internal','内部任务','/saved',0,30,'subagent','custom');`)
	saveDesktopState(t, home, map[string]any{"local-projects": map[string]any{"p": map[string]any{"id": "p", "name": "保存的项目", "rootPaths": []string{"/saved"}}}})
	idx, err := readDesktopIndex(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Projects) != 1 || len(idx.Threads) != 2 || idx.Threads[0].ID != "custom" || idx.Threads[1].ID != "official" || idx.Threads[0].ProjectID != "p" || idx.Threads[0].Recency != 20000 {
		t.Fatalf("unexpected catalog: %+v", idx)
	}
	var provider string
	if err := db.QueryRow(`SELECT model_provider FROM threads WHERE id='custom'`).Scan(&provider); err != nil || provider != "custom" {
		t.Fatalf("provider changed: %q %v", provider, err)
	}
}

func TestObsoleteSessionIndexDoesNotOverrideDesktopTitleOrVersion(t *testing.T) {
	home := t.TempDir()
	db := testutil.Desktop(t, home)
	testutil.Exec(t, db, `INSERT INTO threads(id,title) VALUES ('thread','桌面标题')`)
	os.MkdirAll(filepath.Join(home, "sessions"), 0700)
	os.WriteFile(filepath.Join(home, "sessions", "thread.jsonl"), []byte(meta("thread")+canonical("u", "UserMessage", "hello")), 0600)
	s, err := New(home)
	if err != nil {
		t.Fatal(err)
	}
	s.Refresh(true)
	before := s.Sidebar()
	for _, name := range []string{"过期标题", "另一个过期标题"} {
		raw, _ := json.Marshal(map[string]string{"id": "thread", "thread_name": name})
		os.WriteFile(filepath.Join(home, "session_index.jsonl"), append(raw, '\n'), 0600)
		s.Refresh(false)
		page, ok := s.Read("thread", "", "", 50)
		if !ok || page.Thread.Title != "桌面标题" || s.Sidebar().Version != before.Version {
			t.Fatalf("obsolete index affected catalog: %+v", page.Thread)
		}
	}
}
