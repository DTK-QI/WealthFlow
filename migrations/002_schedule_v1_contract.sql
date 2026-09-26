ALTER TABLE schedules ADD COLUMN interval INTEGER NOT NULL DEFAULT 1 CHECK (interval BETWEEN 1 AND 1000);
ALTER TABLE schedules ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Asia/Taipei';
ALTER TABLE schedules ADD COLUMN start_date TEXT NOT NULL DEFAULT '1970-01-01';
ALTER TABLE schedules ADD COLUMN end_date TEXT;
ALTER TABLE schedules ADD COLUMN monthly_missing_day_policy TEXT NOT NULL DEFAULT 'LAST_DAY'
  CHECK (monthly_missing_day_policy IN ('LAST_DAY','SKIP'));
ALTER TABLE schedules ADD COLUMN auto_post INTEGER NOT NULL DEFAULT 0 CHECK (auto_post IN (0,1));
ALTER TABLE schedules ADD COLUMN catch_up_policy TEXT NOT NULL DEFAULT 'BACKFILL'
  CHECK (catch_up_policy IN ('BACKFILL','SKIP'));
ALTER TABLE schedules ADD COLUMN paused_at TEXT;

UPDATE schedules
SET start_date = substr(created_at, 1, 10),
    auto_post = CASE WHEN require_confirmation = 0 THEN 1 ELSE 0 END;

-- Legacy kinds remain available only as historical data. They cannot be scheduled or shown as v1 schedules.
UPDATE schedules
SET status = 'ARCHIVED', next_run_at = NULL
WHERE activity_kind NOT IN ('DEPOSIT','TRANSFER');

ALTER TABLE executions ADD COLUMN schedule_snapshot TEXT NOT NULL DEFAULT '{}';

UPDATE executions
SET schedule_snapshot = COALESCE((
  SELECT json_object(
    'id', s.id,
    'name', s.name,
    'frequency', s.frequency,
    'interval', s.interval,
    'timeZone', s.time_zone,
    'startDate', s.start_date,
    'endDate', s.end_date,
    'localTime', s.local_time,
    'weekday', s.weekday,
    'dayOfMonth', s.day_of_month,
    'monthlyMissingDayPolicy', s.monthly_missing_day_policy,
    'accountId', s.account_id,
    'destinationAccountId', s.destination_account_id,
    'activityKind', s.activity_kind,
    'amount', s.amount,
    'currency', s.currency,
    'symbol', s.symbol,
    'note', s.note,
    'autoPost', json(CASE WHEN s.auto_post = 1 THEN 'true' ELSE 'false' END),
    'requireConfirmation', json(CASE WHEN s.require_confirmation = 1 THEN 'true' ELSE 'false' END),
    'catchUpPolicy', s.catch_up_policy
  ) FROM schedules s WHERE s.id = executions.schedule_id
), '{}');

CREATE TRIGGER schedules_v1_insert_guard
BEFORE INSERT ON schedules
BEGIN
  SELECT CASE WHEN NEW.activity_kind NOT IN ('DEPOSIT','TRANSFER')
    THEN RAISE(ABORT, 'v1 activity_kind must be DEPOSIT or TRANSFER') END;
  SELECT CASE WHEN NEW.auto_post = NEW.require_confirmation
    THEN RAISE(ABORT, 'auto_post and require_confirmation must be complementary') END;
  SELECT CASE WHEN NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date
    THEN RAISE(ABORT, 'end_date must not precede start_date') END;
END;

CREATE TRIGGER schedules_v1_update_guard
BEFORE UPDATE OF activity_kind, auto_post, require_confirmation, start_date, end_date ON schedules
BEGIN
  SELECT CASE WHEN NEW.activity_kind NOT IN ('DEPOSIT','TRANSFER')
    THEN RAISE(ABORT, 'v1 activity_kind must be DEPOSIT or TRANSFER') END;
  SELECT CASE WHEN NEW.auto_post = NEW.require_confirmation
    THEN RAISE(ABORT, 'auto_post and require_confirmation must be complementary') END;
  SELECT CASE WHEN NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date
    THEN RAISE(ABORT, 'end_date must not precede start_date') END;
END;

CREATE INDEX IF NOT EXISTS idx_executions_schedule_status_date
ON executions(schedule_id, status, scheduled_for DESC);
