PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','ARCHIVED')),
  frequency TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY')),
  local_time TEXT NOT NULL,
  weekday INTEGER,
  day_of_month INTEGER,
  account_id TEXT NOT NULL,
  destination_account_id TEXT,
  activity_kind TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  symbol TEXT,
  note TEXT,
  require_confirmation INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((frequency = 'WEEKLY' AND weekday BETWEEN 1 AND 7) OR (frequency <> 'WEEKLY' AND weekday IS NULL)),
  CHECK ((frequency = 'MONTHLY' AND day_of_month BETWEEN 1 AND 31) OR (frequency <> 'MONTHLY' AND day_of_month IS NULL)),
  CHECK ((activity_kind = 'TRANSFER' AND destination_account_id IS NOT NULL AND destination_account_id <> account_id) OR (activity_kind <> 'TRANSFER' AND destination_account_id IS NULL))
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING_CONFIRMATION','PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED','UNKNOWN')),
  attempt INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  adapter_reference TEXT,
  error_message TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status, scheduled_for DESC);

CREATE TABLE IF NOT EXISTS accounts_cache (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_activities (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
