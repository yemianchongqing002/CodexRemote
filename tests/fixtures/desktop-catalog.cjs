// Current Codex desktop metadata schema, used only with isolated test homes.
const {DatabaseSync}=require('node:sqlite');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
function catalog(home,projects,threads){
 const db=new DatabaseSync(join(home,'state_5.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);
 CREATE TABLE IF NOT EXISTS project_roots(project_id TEXT,path TEXT,position INTEGER);
 CREATE TABLE IF NOT EXISTS thread_sections(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT DEFAULT '',name TEXT,cwd TEXT DEFAULT '',archived INTEGER DEFAULT 0,recency_at_ms INTEGER DEFAULT 0,recency_at INTEGER DEFAULT 0,updated_at_ms INTEGER DEFAULT 0,updated_at INTEGER DEFAULT 0,source TEXT DEFAULT 'vscode',thread_source TEXT DEFAULT 'user',is_pinned INTEGER DEFAULT 0,thread_section_id TEXT,section_position INTEGER,project_id TEXT);`);
 for(const [position,p] of projects.entries()){
  db.prepare('INSERT INTO projects(id,name,position) VALUES (?,?,?)').run(p.id,p.name,position);
  db.prepare('INSERT INTO project_roots(project_id,path,position) VALUES (?,?,0)').run(p.id,p.path);
 }
 for(const t of threads)db.prepare('INSERT INTO threads(id,title,cwd,recency_at_ms,project_id) VALUES (?,?,?,?,?)').run(t.id,t.title,t.cwd||'',t.recency||Date.now(),t.projectId||null);
 writeFileSync(join(home,'.codex-global-state.json'),JSON.stringify({'local-projects':{},'projectless-thread-ids':threads.filter(t=>!t.projectId).map(t=>t.id)}));
 return db;
}
module.exports={catalog};
