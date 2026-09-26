import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Account, Execution, Schedule, ScheduleSnapshot } from "./types.js";

type SqlValue = string | number | bigint | null | Uint8Array;

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  migrate(migrationsDirectory = path.resolve("migrations")): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      this.db.prepare("SELECT version FROM schema_migrations").all().map((row) => String(row.version)),
    );
    for (const file of fs.readdirSync(migrationsDirectory).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDirectory, file), "utf8");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void { this.db.close(); }

  run(sql: string, ...values: SqlValue[]) { return this.db.prepare(sql).run(...values); }
  get(sql: string, ...values: SqlValue[]) { return this.db.prepare(sql).get(...values); }
  all(sql: string, ...values: SqlValue[]) { return this.db.prepare(sql).all(...values); }
}

function str(value: unknown): string { return String(value); }
function nullable(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }

export function mapSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: str(row.id), name: str(row.name), status: str(row.status) as Schedule["status"],
    frequency: str(row.frequency) as Schedule["frequency"], interval: Number(row.interval),
    timeZone: str(row.time_zone), startDate: str(row.start_date), endDate: nullable(row.end_date),
    localTime: str(row.local_time),
    weekday: row.weekday === null ? null : Number(row.weekday), dayOfMonth: row.day_of_month === null ? null : Number(row.day_of_month),
    monthlyMissingDayPolicy: str(row.monthly_missing_day_policy) as Schedule["monthlyMissingDayPolicy"],
    accountId: str(row.account_id), destinationAccountId: nullable(row.destination_account_id),
    activityKind: str(row.activity_kind) as Schedule["activityKind"], amount: str(row.amount), currency: str(row.currency),
    symbol: nullable(row.symbol), note: nullable(row.note), autoPost: Number(row.auto_post) === 1,
    requireConfirmation: Number(row.require_confirmation) === 1,
    catchUpPolicy: str(row.catch_up_policy) as Schedule["catchUpPolicy"], nextRunAt: nullable(row.next_run_at),
    pausedAt: nullable(row.paused_at), createdAt: str(row.created_at), updatedAt: str(row.updated_at),
  };
}

export function scheduleSnapshot(schedule: Schedule): ScheduleSnapshot {
  const { status: _status, nextRunAt: _nextRunAt, pausedAt: _pausedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...snapshot } = schedule;
  return snapshot;
}

export function mapExecution(row: Record<string, unknown>): Execution {
  const snapshot = JSON.parse(str(row.schedule_snapshot)) as ScheduleSnapshot;
  return {
    id: str(row.id), scheduleId: str(row.schedule_id), scheduleName: snapshot.name ?? nullable(row.schedule_name) ?? undefined,
    amount: snapshot.amount, currency: snapshot.currency, activityKind: snapshot.activityKind, scheduleSnapshot: snapshot,
    scheduledFor: str(row.scheduled_for), status: str(row.status) as Execution["status"], attempt: Number(row.attempt),
    idempotencyKey: str(row.idempotency_key), adapterReference: nullable(row.adapter_reference), errorMessage: nullable(row.error_message),
    leaseOwner: nullable(row.lease_owner), leaseUntil: nullable(row.lease_until), startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at), createdAt: str(row.created_at),
  };
}

export function mapAccount(row: Record<string, unknown>): Account {
  return { id: str(row.id), name: str(row.name), currency: str(row.currency), source: str(row.source) };
}
