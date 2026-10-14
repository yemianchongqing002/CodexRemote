// Package testutil builds isolated Codex catalog fixtures for integration tests.
package testutil

import (
	"database/sql"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"testing"
)

func Desktop(t testing.TB, home string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(home, "state_5.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	Exec(t, db, `PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
 CREATE TABLE IF NOT EXISTS project_roots(project_id TEXT,path TEXT,position INTEGER);
 CREATE TABLE IF NOT EXISTS thread_sections(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT DEFAULT '',name TEXT,cwd TEXT DEFAULT '',archived INTEGER DEFAULT 0,recency_at_ms INTEGER DEFAULT 0,recency_at INTEGER DEFAULT 0,updated_at_ms INTEGER DEFAULT 0,updated_at INTEGER DEFAULT 0,source TEXT DEFAULT 'vscode',thread_source TEXT DEFAULT 'user',is_pinned INTEGER DEFAULT 0,thread_section_id TEXT,section_position INTEGER,project_id TEXT);`)
	if _, err = os.Stat(filepath.Join(home, ".codex-global-state.json")); os.IsNotExist(err) {
		if err = os.WriteFile(filepath.Join(home, ".codex-global-state.json"), []byte(`{"local-projects":{}}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
func Exec(t testing.TB, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
