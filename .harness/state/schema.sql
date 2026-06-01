-- agent-harness-kit operational state schema.
-- The database is local runtime state and is not committed. This schema is
-- committed so agents can initialize and query durable task records.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS state_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO state_migration (version, name) VALUES (1, 'initial-operational-state');

CREATE TABLE IF NOT EXISTS intake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  input_type TEXT NOT NULL CHECK(input_type IN (
    'new_spec',
    'spec_slice',
    'change_request',
    'new_initiative',
    'maintenance',
    'harness_improvement'
  )),
  summary TEXT NOT NULL,
  risk_lane TEXT NOT NULL CHECK(risk_lane IN ('tiny', 'normal', 'high-risk')),
  risk_flags TEXT,
  affected_docs TEXT,
  story_id TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS story (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  risk_lane TEXT NOT NULL CHECK(risk_lane IN ('tiny', 'normal', 'high-risk')),
  contract_doc TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN (
    'planned',
    'in_progress',
    'implemented',
    'changed',
    'retired'
  )),
  unit_proof INTEGER NOT NULL DEFAULT 0 CHECK(unit_proof IN (0, 1)),
  integration_proof INTEGER NOT NULL DEFAULT 0 CHECK(integration_proof IN (0, 1)),
  e2e_proof INTEGER NOT NULL DEFAULT 0 CHECK(e2e_proof IN (0, 1)),
  platform_proof INTEGER NOT NULL DEFAULT 0 CHECK(platform_proof IN (0, 1)),
  evidence TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS decision_record (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN (
    'proposed',
    'accepted',
    'superseded',
    'rejected'
  )),
  doc_path TEXT,
  verify_command TEXT,
  predicted_impact TEXT,
  actual_outcome TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS backlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT NOT NULL,
  discovered_while TEXT,
  current_pain TEXT,
  suggested_improvement TEXT,
  risk TEXT CHECK(risk IN ('tiny', 'normal', 'high-risk') OR risk IS NULL),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN (
    'proposed',
    'accepted',
    'implemented',
    'rejected'
  )),
  predicted_impact TEXT,
  actual_outcome TEXT,
  implemented_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  task_summary TEXT NOT NULL,
  intake_id INTEGER REFERENCES intake(id),
  story_id TEXT REFERENCES story(id),
  agent TEXT,
  risk_lane TEXT NOT NULL DEFAULT 'normal' CHECK(risk_lane IN ('tiny', 'normal', 'high-risk')),
  actions_taken TEXT,
  files_read TEXT,
  files_changed TEXT,
  decisions_made TEXT,
  errors TEXT,
  outcome TEXT CHECK(outcome IN ('completed', 'blocked', 'partial', 'failed') OR outcome IS NULL),
  duration_seconds INTEGER,
  token_estimate INTEGER,
  harness_friction TEXT,
  trace_quality_score INTEGER NOT NULL DEFAULT 0,
  trace_quality_tier TEXT NOT NULL DEFAULT 'insufficient' CHECK(trace_quality_tier IN (
    'insufficient',
    'minimal',
    'standard',
    'detailed'
  )),
  trace_quality_reasons TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS session_worktree (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  task_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT,
  source_root TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  manifest_path TEXT,
  active_task_env TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'planned',
    'active',
    'stale',
    'removed',
    'closed'
  )),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_intake_created_at ON intake(created_at);
CREATE INDEX IF NOT EXISTS idx_story_status ON story(status);
CREATE INDEX IF NOT EXISTS idx_backlog_status ON backlog(status);
CREATE INDEX IF NOT EXISTS idx_trace_created_at ON trace(created_at);
CREATE INDEX IF NOT EXISTS idx_trace_story_id ON trace(story_id);
CREATE INDEX IF NOT EXISTS idx_trace_quality ON trace(trace_quality_score, risk_lane);
CREATE INDEX IF NOT EXISTS idx_session_worktree_task ON session_worktree(task_id, status);
CREATE INDEX IF NOT EXISTS idx_session_worktree_path ON session_worktree(worktree_path);
