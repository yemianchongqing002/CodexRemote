package chat

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type desktopThread struct {
	ID, Title, Cwd, ProjectID string
	Archived, Pinned          bool
	Section                   string
	Position                  int64
	Recency                   int64
}
type desktopIndex struct {
	Sections []SidebarSection

	Projects []Project
	Threads  []desktopThread
}
type desktopState struct {
	Projects map[string]struct {
		ID    string   `json:"id"`
		Name  string   `json:"name"`
		Roots []string `json:"rootPaths"`
	} `json:"local-projects"`
	Order       []string `json:"project-order"`
	Assignments map[string]struct {
		Kind string `json:"projectKind"`
		ID   string `json:"projectId"`
	} `json:"thread-project-assignments"`
	Projectless  []string                     `json:"projectless-thread-ids"`
	ThreadOrders map[string][]string          `json:"sidebar-project-thread-orders"`
	Migrations   map[string]map[string]string `json:"app-server-project-id-by-legacy-project-id-by-host"`
	Atoms        map[string]json.RawMessage   `json:"electron-persisted-atom-state"`
}

func readDesktopIndex(home string) (*desktopIndex, error) {
	file, err := os.Open(filepath.Join(home, ".codex-global-state.json"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (8<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 8<<20 {
		return nil, errors.New("desktop state exceeds limit")
	}
	var state desktopState
	if err = json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	paths, err := filepath.Glob(filepath.Join(home, "state_*.sqlite"))
	if err != nil {
		return nil, err
	}
	dbPath := ""
	version := -1
	for _, p := range paths {
		n, e := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(p), "state_"), ".sqlite"))
		if e == nil && n > version {
			version = n
			dbPath = p
		}
	}
	if dbPath == "" {
		return nil, errors.New("desktop database missing")
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(dbPath)}
	q := u.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(1000)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Read one SQLite snapshot, including WAL. Never copy or mutate Codex's DB.
	idx := &desktopIndex{Projects: []Project{}, Threads: []desktopThread{}}
	aliases := map[string]string{}
	for legacy, current := range state.Migrations["local:"+home] {
		if _, ok := state.Projects[legacy]; ok {
			aliases[current] = legacy
		}
	}
	projectColumns, err := desktopColumns(ctx, tx, "projects")
	if err != nil {
		return nil, err
	}
	projectQuery := `SELECT p.id,p.name,r.path FROM projects p LEFT JOIN project_roots r ON r.project_id=p.id ORDER BY p.position,p.id,r.position`
	if len(projectColumns) == 0 {
		// Older desktops keep saved projects entirely in global state.
		projectQuery = `SELECT NULL,NULL,NULL WHERE 0`
	}
	projectRows, err := tx.QueryContext(ctx, projectQuery)
	if err != nil {
		return nil, err
	}
	byID := map[string]Project{}
	var order []string
	for projectRows.Next() {
		var id, name string
		var root sql.NullString
		if err = projectRows.Scan(&id, &name, &root); err != nil {
			projectRows.Close()
			return nil, err
		}
		if a := aliases[id]; a != "" {
			id = a
		}
		p, ok := byID[id]
		if !ok {
			p = Project{ID: id, Name: name, Roots: []string{}}
			order = append(order, id)
		}
		if root.Valid {
			p.Roots = append(p.Roots, root.String)
		}
		byID[id] = p
	}
	err = projectRows.Err()
	projectRows.Close()
	if err != nil {
		return nil, err
	}
	for id, p := range state.Projects {
		byID[id] = Project{ID: id, Name: p.Name, Roots: p.Roots}
	}
	var unified []string
	_ = json.Unmarshal(state.Atoms["unified-sidebar-project-order-v1"], &unified)
	preferred := []string{}
	for _, key := range unified {
		if strings.HasPrefix(key, "codex:project:") {
			preferred = append(preferred, strings.TrimPrefix(key, "codex:project:"))
		}
	}
	preferred = append(preferred, state.Order...)
	preferred = append(preferred, order...)
	// Include saved projects even if they have no tasks, with stable tie ordering.
	extras := []string{}
	for id := range byID {
		extras = append(extras, id)
	}
	sort.Strings(extras)
	preferred = append(preferred, extras...)
	seen := map[string]bool{}
	for _, id := range preferred {
		p, ok := byID[id]
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		if len(p.Roots) > 0 {
			p.Path = p.Roots[0]
			if info, e := os.Stat(p.Path); e == nil {
				p.Available = info.IsDir()
			}
		}
		byID[id] = p
		idx.Projects = append(idx.Projects, p)
	}
	projectless := map[string]bool{}
	for _, id := range state.Projectless {
		projectless[id] = true
	}
	columns, err := desktopColumns(ctx, tx, "threads")
	if err != nil {
		return nil, err
	}
	for _, required := range []string{"id", "title", "cwd", "archived", "updated_at", "source"} {
		if !columns[required] {
			return nil, fmt.Errorf("任务数据库缺少必要字段 threads.%s", required)
		}
	}
	field := func(name, fallback string) string {
		if columns[name] {
			return name
		}
		return fallback
	}
	recency := "COALESCE(NULLIF(" + field("recency_at_ms", "0") + ",0),NULLIF(" + field("recency_at", "0") + ",0)*1000,NULLIF(" + field("updated_at_ms", "0") + ",0),updated_at*1000)"
	query := "SELECT id,COALESCE(NULLIF(" + field("name", "''") + ",''),title),cwd,archived," + recency + ",source,COALESCE(" + field("thread_source", "''") + ",'')," + field("is_pinned", "0") + ",COALESCE(" + field("thread_section_id", "''") + ",''),COALESCE(" + field("section_position", "NULL") + ",9223372036854775807),COALESCE(" + field("project_id", "''") + ",'') FROM threads ORDER BY " + recency + " DESC,id LIMIT 10001"
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
		if count > 10000 {
			return nil, errors.New("desktop thread count exceeds limit")
		}
		var t desktopThread
		var source, kind string
		if err = rows.Scan(&t.ID, &t.Title, &t.Cwd, &t.Archived, &t.Recency, &source, &kind, &t.Pinned, &t.Section, &t.Position, &t.ProjectID); err != nil {
			return nil, err
		}
		if kind != "" && kind != "user" {
			continue
		}
		if source != "cli" && source != "vscode" && source != "exec" && source != "appServer" {
			continue
		}
		var deleted bool
		_ = json.Unmarshal(state.Atoms["codex-writing-block-deleted-thread-v1:"+t.ID], &deleted)
		if deleted {
			continue
		}
		if a := aliases[t.ProjectID]; a != "" {
			t.ProjectID = a
		}
		if assignment, ok := state.Assignments[t.ID]; ok {
			t.ProjectID = ""
			if assignment.Kind == "local" {
				t.ProjectID = assignment.ID
			}
		} else if projectless[t.ID] {
			t.ProjectID = ""
		} else if t.ProjectID == "" {
			// Legacy desktop tasks without an explicit assignment use an exact saved root.
			// This never creates a project and never overrides explicit projectless tasks.
			for _, p := range idx.Projects {
				for _, root := range p.Roots {
					if filepath.Clean(t.Cwd) == filepath.Clean(root) {
						t.ProjectID = p.ID
						break
					}
				}
				if t.ProjectID != "" {
					break
				}
			}
		}
		if _, ok := byID[t.ProjectID]; !ok {
			t.ProjectID = ""
		}
		idx.Threads = append(idx.Threads, t)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(idx.Threads, func(i, j int) bool {
		a, b := idx.Threads[i], idx.Threads[j]
		if a.Recency != b.Recency {
			return a.Recency > b.Recency
		}
		return a.ID < b.ID
	})
	for i := range idx.Projects {
		idx.Projects[i].ThreadOrder = state.ThreadOrders[idx.Projects[i].ID]
	}
	sectionColumns, err := desktopColumns(ctx, tx, "thread_sections")
	if err != nil {
		return nil, err
	}
	if len(sectionColumns) == 0 {
		return idx, nil
	}
	sectionRows, err := tx.QueryContext(ctx, "SELECT id,name FROM thread_sections ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	for sectionRows.Next() {
		var section SidebarSection
		if err = sectionRows.Scan(&section.ID, &section.Name); err != nil {
			sectionRows.Close()
			return nil, err
		}
		idx.Sections = append(idx.Sections, section)
	}
	err = sectionRows.Err()
	sectionRows.Close()
	if err != nil {
		return nil, err
	}

	return idx, nil
}

// Table names are fixed internal constants; introspection never changes the catalog.
func desktopColumns(ctx context.Context, tx *sql.Tx, table string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &defaultValue, &pk); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}
