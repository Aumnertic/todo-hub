-- 参与者：人和各个 Agent
CREATE TABLE actors (
  id               TEXT PRIMARY KEY,                   -- 'me' / 'muse' / 'grok-bot'
  kind             TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  display_name     TEXT NOT NULL,
  access_client_id TEXT UNIQUE,                        -- CF Access service token client id
  email            TEXT UNIQUE,                        -- 人类：Access 登录邮箱，也是通知地址
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);

INSERT INTO actors (id, kind, display_name, created_at)
VALUES ('system', 'system', 'System', unixepoch() * 1000);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,                        -- ULID
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance  TEXT NOT NULL DEFAULT '',
  project     TEXT,
  priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  status      TEXT NOT NULL CHECK (status IN
                ('proposed', 'todo', 'claimed', 'blocked', 'review', 'done', 'cancelled')),
  assignee    TEXT REFERENCES actors(id),              -- NULL = 谁都能领
  created_by  TEXT NOT NULL REFERENCES actors(id),
  claimed_by  TEXT REFERENCES actors(id),
  lease_until INTEGER,                                 -- unix ms
  due_at      INTEGER,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER
);
CREATE INDEX idx_tasks_queue   ON tasks (status, assignee, priority, created_at);
CREATE INDEX idx_tasks_project ON tasks (project, status);
CREATE INDEX idx_tasks_lease   ON tasks (status, lease_until);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  actor       TEXT NOT NULL REFERENCES actors(id),
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  body        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_events_task ON task_events (task_id, created_at);

CREATE TABLE task_artifacts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  kind       TEXT NOT NULL,                            -- pr / commit / preview / url
  url        TEXT NOT NULL,
  note       TEXT,
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_task ON task_artifacts (task_id);

CREATE TABLE task_deps (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);
CREATE INDEX idx_deps_rev ON task_deps (depends_on);
