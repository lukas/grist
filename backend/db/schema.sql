PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  user_goal TEXT NOT NULL,
  operator_notes TEXT DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  selected_execution_mode TEXT NOT NULL DEFAULT 'local',
  default_model_provider TEXT NOT NULL DEFAULT 'mock',
  planner_model_provider TEXT NOT NULL DEFAULT 'mock',
  reducer_model_provider TEXT NOT NULL DEFAULT 'mock',
  verifier_model_provider TEXT NOT NULL DEFAULT 'mock',
  total_tokens_used INTEGER NOT NULL DEFAULT 0,
  total_estimated_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  assigned_model_provider TEXT NOT NULL,
  write_mode TEXT NOT NULL DEFAULT 'none',
  workspace_repo_mode TEXT NOT NULL DEFAULT 'shared_read_only',
  scratchpad_path TEXT NOT NULL DEFAULT '',
  worktree_path TEXT,
  max_steps INTEGER NOT NULL DEFAULT 24,
  max_tokens INTEGER NOT NULL DEFAULT 32000,
  steps_used INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  current_action TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  files_examined_json TEXT NOT NULL DEFAULT '[]',
  findings_json TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  artifact_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  stalled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  content_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
