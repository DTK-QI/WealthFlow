import { randomUUID } from "node:crypto";
import { futureOccurrences, nextOccurrence } from "./calendar.js";
import { AppDatabase, mapSchedule } from "./database.js";
import type { Schedule, ScheduleInput } from "./types.js";

const columns = `id, name, status, frequency, interval, time_zone, start_date, end_date,
local_time, weekday, day_of_month, monthly_missing_day_policy, account_id, destination_account_id,
activity_kind, amount, currency, symbol, note, auto_post, require_confirmation, catch_up_policy,
next_run_at, paused_at, created_at, updated_at`;

export class ScheduleService {
  constructor(private readonly database: AppDatabase) {}

  list(now: Date = new Date()): Array<Schedule & { futureRuns: string[] }> {
    return this.database.all(
      `SELECT ${columns} FROM schedules WHERE activity_kind IN ('DEPOSIT','TRANSFER') ORDER BY status, next_run_at, created_at DESC`,
    ).map((row) => {
      const schedule = mapSchedule(row);
      return {
        ...schedule,
        futureRuns: schedule.status === "ARCHIVED" ? [] : futureOccurrences(schedule, 5, now),
      };
    });
  }

  get(id: string): Schedule | null {
    const row = this.database.get(`SELECT ${columns} FROM schedules WHERE id = ?`, id);
    return row ? mapSchedule(row) : null;
  }

  preview(input: ScheduleInput, after: Date = new Date()): { futureRuns: string[] } {
    return { futureRuns: futureOccurrences(input, 5, after) };
  }

  create(input: ScheduleInput, now = new Date()): Schedule {
    const id = randomUUID();
    const timestamp = now.toISOString();
    const next = nextOccurrence(input, now);
    this.database.run(
      `INSERT INTO schedules (${columns})
       VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id, input.name, input.frequency, input.interval, input.timeZone, input.startDate, input.endDate,
      input.localTime, input.weekday, input.dayOfMonth, input.monthlyMissingDayPolicy,
      input.accountId, input.destinationAccountId, input.activityKind, input.amount, input.currency,
      input.symbol, input.note, input.autoPost ? 1 : 0, input.requireConfirmation ? 1 : 0,
      input.catchUpPolicy, next, timestamp, timestamp,
    );
    return this.get(id)!;
  }

  update(id: string, input: ScheduleInput, now = new Date()): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next = existing.status === "ARCHIVED" ? null : nextOccurrence(input, now);
    this.database.run(
      `UPDATE schedules SET name=?, frequency=?, interval=?, time_zone=?, start_date=?, end_date=?,
       local_time=?, weekday=?, day_of_month=?, monthly_missing_day_policy=?, account_id=?, destination_account_id=?,
       activity_kind=?, amount=?, currency=?, symbol=?, note=?, auto_post=?, require_confirmation=?, catch_up_policy=?,
       next_run_at=?, updated_at=? WHERE id=?`,
      input.name, input.frequency, input.interval, input.timeZone, input.startDate, input.endDate,
      input.localTime, input.weekday, input.dayOfMonth, input.monthlyMissingDayPolicy, input.accountId,
      input.destinationAccountId, input.activityKind, input.amount, input.currency, input.symbol, input.note,
      input.autoPost ? 1 : 0, input.requireConfirmation ? 1 : 0, input.catchUpPolicy, next, now.toISOString(), id,
    );
    return this.get(id);
  }

  pause(id: string, now = new Date()): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.status === "ARCHIVED") throw new Error("已封存排程不可暫停");
    this.database.run(
      "UPDATE schedules SET status='PAUSED', paused_at=?, updated_at=? WHERE id=?",
      now.toISOString(), now.toISOString(), id,
    );
    return this.get(id);
  }

  resume(id: string, catchUpPaused: boolean, now = new Date()): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.status !== "PAUSED") throw new Error("只有已暫停排程可以恢復");
    const next = catchUpPaused ? existing.nextRunAt : nextOccurrence(existing, now);
    this.database.run(
      "UPDATE schedules SET status='ACTIVE', next_run_at=?, paused_at=NULL, updated_at=? WHERE id=?",
      next, now.toISOString(), id,
    );
    return this.get(id);
  }

  archive(id: string, now = new Date()): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.database.run(
      "UPDATE schedules SET status='ARCHIVED', next_run_at=NULL, paused_at=NULL, updated_at=? WHERE id=?",
      now.toISOString(), id,
    );
    return this.get(id);
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.status !== "ARCHIVED") throw new Error("僅可刪除已封存排程");
    const executions = Number(this.database.get("SELECT COUNT(*) AS count FROM executions WHERE schedule_id=?", id)?.count ?? 0);
    if (executions > 0) throw new Error("已有執行紀錄，為保留稽核軌跡不可刪除；請維持封存");
    return this.database.run("DELETE FROM schedules WHERE id=?", id).changes === 1;
  }
}
