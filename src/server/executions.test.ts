import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockWealthfolioAdapter } from "./adapters/mock.js";
import { AppDatabase } from "./database.js";
import { ExecutionService } from "./executions.js";
import { ScheduleService } from "./schedules.js";
import type { ScheduleInput, WealthfolioAdapter } from "./types.js";

const cleanup: Array<() => void> = [];
const baseInput: ScheduleInput = {
  name: "薪資", frequency: "MONTHLY", interval: 1, timeZone: "Asia/Taipei", startDate: "2026-01-01", endDate: null,
  localTime: "09:00", weekday: null, dayOfMonth: 1, monthlyMissingDayPolicy: "LAST_DAY",
  accountId: "mock-cash-twd", destinationAccountId: null, activityKind: "DEPOSIT", amount: "50000.25",
  currency: "TWD", symbol: null, note: null, autoPost: true, requireConfirmation: false, catchUpPolicy: "BACKFILL",
};
function setup(materializeBatchLimit = 100) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wealthflow-test-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  database.migrate(path.resolve("migrations"));
  cleanup.push(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const adapter = new MockWealthfolioAdapter(database);
  const schedules = new ScheduleService(database);
  const executions = new ExecutionService(database, adapter, { schedulerPollMs: 1000, executionTimeoutMs: 100, leaseSeconds: 1, materializeBatchLimit });
  return { database, schedules, executions };
}
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); });

describe("durable execution", () => {
  it("materializes a due schedule exactly once and persists mock activity", async () => {
    const { database, schedules, executions } = setup();
    const schedule = schedules.create(baseInput);
    database.run("UPDATE schedules SET next_run_at=? WHERE id=?", "2026-01-01T01:00:00Z", schedule.id);
    const now = new Date("2026-01-01T01:01:00Z");
    const competingWorker = new ExecutionService(database, new MockWealthfolioAdapter(database), { schedulerPollMs: 1000, executionTimeoutMs: 100, leaseSeconds: 1, materializeBatchLimit: 100 });
    await Promise.all([executions.tick(now), competingWorker.tick(now)]);
    expect(executions.list()).toHaveLength(1);
    expect(executions.list()[0]?.status).toBe("SUCCEEDED");
    expect(database.get("SELECT COUNT(*) AS count FROM mock_activities")?.count).toBe(1);
  });

  it("BACKFILL catches up one original occurrence per execution with a batch cap", async () => {
    const { database, schedules, executions } = setup(2);
    const schedule = schedules.create({ ...baseInput, frequency: "DAILY", dayOfMonth: null });
    database.run("UPDATE schedules SET next_run_at=? WHERE id=?", "2026-01-01T01:00:00Z", schedule.id);
    await executions.tick(new Date("2026-01-03T02:00:00Z"));
    expect(executions.list().map((item) => item.scheduledFor).sort()).toEqual(["2026-01-01T01:00:00Z", "2026-01-02T01:00:00Z"]);
    await executions.tick(new Date("2026-01-03T02:00:00Z"));
    expect(executions.list()).toHaveLength(3);
  });

  it("SKIP drops overdue periods and advances to the next future period", async () => {
    const { database, schedules, executions } = setup();
    const schedule = schedules.create({ ...baseInput, frequency: "DAILY", dayOfMonth: null, catchUpPolicy: "SKIP" });
    database.run("UPDATE schedules SET next_run_at=? WHERE id=?", "2026-01-01T01:00:00Z", schedule.id);
    await executions.tick(new Date("2026-01-03T02:00:00Z"));
    expect(executions.list()).toHaveLength(0);
    expect(schedules.get(schedule.id)?.nextRunAt).toBe("2026-01-04T01:00:00Z");
  });

  it("uses the materialized schedule snapshot after a later edit", async () => {
    const { database, schedules, executions } = setup();
    const schedule = schedules.create({ ...baseInput, autoPost: false, requireConfirmation: true, amount: "100" });
    database.run("UPDATE schedules SET next_run_at=? WHERE id=?", "2026-01-01T01:00:00Z", schedule.id);
    await executions.tick(new Date("2026-01-01T01:01:00Z"));
    const waiting = executions.list()[0]!;
    schedules.update(schedule.id, { ...baseInput, amount: "999" });
    await executions.confirm(waiting.id);
    const payload = JSON.parse(String(database.get("SELECT payload FROM mock_activities")?.payload));
    expect(payload.amount).toBe("100");
    expect(executions.get(waiting.id)?.amount).toBe("100");
  });

  it("requires the explicit next period for immediate execution and rejects a successful duplicate", async () => {
    const { database, schedules, executions } = setup();
    const schedule = schedules.create(baseInput, new Date("2025-12-01T00:00:00Z"));
    const period = schedule.nextRunAt!;
    await expect(executions.runNext(schedule.id, "2026-02-01T01:00:00Z")).rejects.toThrow("nextRunAt");
    await executions.runNext(schedule.id, period);
    database.run("UPDATE schedules SET next_run_at=? WHERE id=?", period, schedule.id);
    await expect(executions.runNext(schedule.id, period)).rejects.toThrow("已成功執行");
  });

  it("marks timeouts unknown and never treats lookup absence as permission to resend", async () => {
    const { database, schedules } = setup();
    let calls = 0;
    const adapter: WealthfolioAdapter = {
      mode: "mock", supportsAtomicTransfer: true,
      async testConnection() { return { ok: true, message: "test" }; }, async listAccounts() { return []; },
      async createActivity() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { reference: "late" }; },
      async createTransfer() { throw new Error("not used"); }, async lookup() { return { state: "NOT_FOUND" }; },
    };
    const executions = new ExecutionService(database, adapter, { schedulerPollMs: 1000, executionTimeoutMs: 5, leaseSeconds: 1, materializeBatchLimit: 100 });
    const schedule = schedules.create({ ...baseInput, frequency: "DAILY", dayOfMonth: null });
    database.run("UPDATE schedules SET next_run_at=? WHERE id=?", "2026-03-01T01:00:00Z", schedule.id);
    await executions.tick(new Date("2026-03-01T01:01:00Z"));
    const unknown = executions.list()[0]!;
    expect(unknown.status).toBe("UNKNOWN");
    await executions.retry(unknown.id); await executions.verify(unknown.id);
    expect(executions.get(unknown.id)?.status).toBe("UNKNOWN"); expect(calls).toBe(1);
  });
});
