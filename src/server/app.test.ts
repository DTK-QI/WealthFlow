import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockWealthfolioAdapter } from "./adapters/mock.js";
import { WealthfolioAddonAdapter } from "./adapters/addon.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { ExecutionService } from "./executions.js";
import { ScheduleService } from "./schedules.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wealthflow-api-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  database.migrate(path.resolve("migrations"));
  const config: AppConfig = {
    host: "127.0.0.1", port: 3000, logLevel: "silent", databasePath: path.join(directory, "test.sqlite"),
    adapterMode: "mock", wealthfolioBridgeUrl: null, wealthfolioBridgeToken: null, wealthflowAddonToken: null,
    schedulerPollMs: 1000, executionTimeoutMs: 100, leaseSeconds: 1, materializeBatchLimit: 100,
  };
  const adapter = new MockWealthfolioAdapter(database);
  const schedules = new ScheduleService(database);
  const executions = new ExecutionService(database, adapter, config);
  const app = await buildApp({ config, database, adapter, schedules, executions });
  cleanup.push(async () => { await app.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, database };
}

async function setupAddon() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wealthflow-addon-api-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  database.migrate(path.resolve("migrations"));
  const token = "addon-test-token-12345678901234567890";
  const config: AppConfig = {
    host: "127.0.0.1", port: 3000, logLevel: "silent", databasePath: path.join(directory, "test.sqlite"),
    adapterMode: "wealthfolio_addon", wealthfolioBridgeUrl: null, wealthfolioBridgeToken: null,
    wealthflowAddonToken: token, schedulerPollMs: 1000, executionTimeoutMs: 100, leaseSeconds: 1,
    materializeBatchLimit: 100,
  };
  const adapter = new WealthfolioAddonAdapter(database, config);
  const schedules = new ScheduleService(database);
  const executions = new ExecutionService(database, adapter, config);
  const app = await buildApp({ config, database, adapter, schedules, executions });
  cleanup.push(async () => { await app.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, database, token };
}

const schedulePayload = {
  name: "每月存款", frequency: "MONTHLY", interval: 1, timeZone: "Asia/Taipei", startDate: "2099-01-01", endDate: null,
  localTime: "09:00", weekday: null, dayOfMonth: 1, monthlyMissingDayPolicy: "LAST_DAY",
  accountId: "mock-cash-twd", destinationAccountId: null, activityKind: "DEPOSIT", amount: "1000",
  currency: "TWD", note: null, autoPost: true, requireConfirmation: false, catchUpPolicy: "BACKFILL",
};

describe("Fastify API", () => {
  it("reports health and refreshes mock accounts", async () => {
    const { app } = await setup();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, adapterMode: "mock", timeZone: "Asia/Taipei" });
    const refreshed = await app.inject({ method: "POST", url: "/api/accounts/refresh" });
    expect(refreshed.statusCode).toBe(200); expect(refreshed.json()).toHaveLength(3);
  });

  it("allows only v1 activity kinds and rejects imprecise monetary input", async () => {
    const { app } = await setup();
    await app.inject({ method: "POST", url: "/api/accounts/refresh" });
    const kind = await app.inject({ method: "POST", url: "/api/schedules", payload: { ...schedulePayload, activityKind: "BUY" } });
    expect(kind.statusCode).toBe(400); expect(kind.json().error).toContain("DEPOSIT");
    const amount = await app.inject({ method: "POST", url: "/api/schedules", payload: { ...schedulePayload, amount: "0.0000000000000000001" } });
    expect(amount.statusCode).toBe(400); expect(amount.json().error).toContain("小數位");
  });

  it("blocks a cross-currency transfer using both cached accounts", async () => {
    const { app } = await setup();
    await app.inject({ method: "POST", url: "/api/accounts/refresh" });
    const response = await app.inject({ method: "POST", url: "/api/schedules", payload: {
      ...schedulePayload, activityKind: "TRANSFER", destinationAccountId: "mock-invest-usd",
    } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toContain("幣別");
  });

  it("previews five occurrences without writing and requires an explicit resume choice", async () => {
    const { app, database } = await setup();
    await app.inject({ method: "POST", url: "/api/accounts/refresh" });
    const preview = await app.inject({ method: "POST", url: "/api/schedules/preview", payload: schedulePayload });
    expect(preview.statusCode).toBe(200); expect(preview.json().futureRuns).toHaveLength(5);
    expect(database.get("SELECT COUNT(*) AS count FROM schedules")?.count).toBe(0);
    const created = await app.inject({ method: "POST", url: "/api/schedules", payload: schedulePayload });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/api/schedules/${id}/pause` });
    const resume = await app.inject({ method: "POST", url: `/api/schedules/${id}/resume`, payload: {} });
    expect(resume.statusCode).toBe(400); expect(resume.json().error).toContain("catchUpPaused");
  });

  it("runs an explicitly selected next period and filters executions with snapshot amount", async () => {
    const { app } = await setup();
    await app.inject({ method: "POST", url: "/api/accounts/refresh" });
    const created = await app.inject({ method: "POST", url: "/api/schedules", payload: schedulePayload });
    const schedule = created.json();
    const run = await app.inject({ method: "POST", url: `/api/schedules/${schedule.id}/run-next`, payload: { scheduledFor: schedule.nextRunAt } });
    expect(run.statusCode).toBe(200); expect(run.json()).toMatchObject({ amount: "1000", currency: "TWD", status: "SUCCEEDED" });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(schedule.nextRunAt));
    const list = await app.inject({ method: "GET", url: `/api/executions?schedule=${schedule.id}&status=SUCCEEDED&date=${date}` });
    expect(list.statusCode).toBe(200); expect(list.json()).toHaveLength(1);
  });

  it("materializes safely for the native add-on and requires an authenticated lease before completion", async () => {
    const { app, token } = await setupAddon();
    const headers = { authorization: `Bearer ${token}` };
    const denied = await app.inject({ method: "GET", url: "/api/addon/status" });
    expect(denied.statusCode).toBe(401);

    const sync = await app.inject({
      method: "POST", url: "/api/addon/accounts/sync", headers,
      payload: { accounts: [{ id: "wf-cash", name: "現金帳戶", currency: "TWD" }] },
    });
    expect(sync.statusCode).toBe(200);

    const autoPost = await app.inject({
      method: "POST", url: "/api/schedules", payload: { ...schedulePayload, accountId: "wf-cash" },
    });
    expect(autoPost.statusCode).toBe(400);
    expect(autoPost.json().error).toContain("不能宣稱背景自動入帳");

    const created = await app.inject({
      method: "POST", url: "/api/schedules",
      payload: { ...schedulePayload, accountId: "wf-cash", autoPost: false, requireConfirmation: true },
    });
    expect(created.statusCode).toBe(201);
    const schedule = created.json();
    const run = await app.inject({
      method: "POST", url: `/api/schedules/${schedule.id}/run-next`, payload: { scheduledFor: schedule.nextRunAt },
    });
    expect(run.json().status).toBe("WAITING_CONFIRMATION");

    const claim = await app.inject({ method: "POST", url: `/api/addon/executions/${run.json().id}/claim`, headers });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().activity).toMatchObject({ id: run.json().id, accountId: "wf-cash", activityType: "DEPOSIT" });

    const unknown = await app.inject({
      method: "POST", url: `/api/addon/executions/${run.json().id}/unknown`, headers,
      payload: { claimToken: claim.json().claimToken, message: "host response lost" },
    });
    expect(unknown.json().status).toBe("UNKNOWN");

    const resolved = await app.inject({
      method: "POST", url: `/api/addon/executions/${run.json().id}/resolve`, headers,
      payload: { reference: run.json().id },
    });
    expect(resolved.json()).toMatchObject({ status: "SUCCEEDED", adapterReference: run.json().id });

    const currentSchedule = (await app.inject({ method: "GET", url: "/api/schedules" })).json()[0];
    const secondRun = await app.inject({
      method: "POST", url: `/api/schedules/${currentSchedule.id}/run-next`,
      payload: { scheduledFor: currentSchedule.nextRunAt },
    });
    const secondClaim = await app.inject({
      method: "POST", url: `/api/addon/executions/${secondRun.json().id}/claim`, headers,
    });
    const completed = await app.inject({
      method: "POST", url: `/api/addon/executions/${secondRun.json().id}/complete`, headers,
      payload: { claimToken: secondClaim.json().claimToken, reference: secondRun.json().id },
    });
    expect(completed.json()).toMatchObject({ status: "SUCCEEDED", adapterReference: secondRun.json().id });
  });
});
