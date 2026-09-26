import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { DateTime } from "luxon";
import type { AppConfig } from "./config.js";
import { AppDatabase, mapAccount } from "./database.js";
import { ExecutionService } from "./executions.js";
import { ScheduleService } from "./schedules.js";
import type { ExecutionStatus, WealthfolioAdapter } from "./types.js";
import { parseResumeInput, parseScheduleInput } from "./validation.js";

export interface AppDependencies {
  config: AppConfig;
  database: AppDatabase;
  adapter: WealthfolioAdapter;
  schedules: ScheduleService;
  executions: ExecutionService;
}

function idParam(params: unknown): string {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== "string" || !id) throw new Error("缺少識別碼");
  return id;
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function sameSecret(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, database, adapter, schedules, executions } = deps;
  const app = Fastify({ logger: { level: config.logLevel } });

  const validatedScheduleBody = (body: unknown) => {
    const input = parseScheduleInput(body);
    if (adapter.mode === "wealthfolio_addon" && input.autoPost) {
      throw new Error("Wealthfolio v3.8.0 add-on 會隨瀏覽器關閉，不能宣稱背景自動入帳；請使用到期後在 add-on 明確確認");
    }
    if (input.activityKind === "TRANSFER" && !adapter.supportsAtomicTransfer) {
      throw new Error("目前 adapter 未確認原子轉帳能力，已停用內部轉帳");
    }
    const accountIds = [input.accountId, input.destinationAccountId].filter((value): value is string => Boolean(value));
    for (const accountId of accountIds) {
      const account = database.get("SELECT id, currency FROM accounts_cache WHERE id=?", accountId);
      if (!account) {
        throw new Error(`帳戶 ${accountId} 不在已刷新快取中，請先刷新帳戶`);
      }
      if (input.activityKind === "TRANSFER" && String(account.currency).toUpperCase() !== input.currency) {
        throw new Error(`轉帳帳戶 ${accountId} 的幣別必須等於排程幣別 ${input.currency}`);
      }
    }
    return input;
  };

  app.setErrorHandler((error, request, reply) => {
    request.log.warn({ err: error }, "request failed");
    const status = (error as { statusCode?: number }).statusCode ?? 400;
    void reply.code(status >= 400 && status < 600 ? status : 500).send({ error: error instanceof Error ? error.message : String(error) });
  });

  const requireAddonRequest = (authorization: string | undefined) => {
    if (adapter.mode !== "wealthfolio_addon") {
      const error = new Error("add-on 交付 API 未啟用") as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
    if (!sameSecret(bearerToken(authorization), config.wealthflowAddonToken)) {
      const error = new Error("add-on bearer token 無效") as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
  };

  app.get("/api/health", async () => ({ ok: true, service: "wealthflow", adapterMode: adapter.mode, timeZone: "Asia/Taipei" }));

  app.get("/api/dashboard", async () => {
    const rows = database.all("SELECT status, COUNT(*) AS count FROM executions GROUP BY status");
    const counts = Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
    const active = Number(database.get("SELECT COUNT(*) AS count FROM schedules WHERE status='ACTIVE'")?.count ?? 0);
    const next = database.get("SELECT next_run_at, name FROM schedules WHERE status='ACTIVE' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 1");
    return { activeSchedules: active, executionCounts: counts, nextRun: next ? { at: String(next.next_run_at), name: String(next.name) } : null };
  });

  app.get("/api/schedules", async () => schedules.list());
  app.post("/api/schedules/preview", async (request) => schedules.preview(validatedScheduleBody(request.body)));
  app.post("/api/schedules", async (request, reply) => reply.code(201).send(schedules.create(validatedScheduleBody(request.body))));
  app.put("/api/schedules/:id", async (request, reply) => {
    const result = schedules.update(idParam(request.params), validatedScheduleBody(request.body));
    return result ?? reply.code(404).send({ error: "找不到排程" });
  });
  app.post("/api/schedules/:id/pause", async (request, reply) => schedules.pause(idParam(request.params)) ?? reply.code(404).send({ error: "找不到排程" }));
  app.post("/api/schedules/:id/resume", async (request, reply) => {
    const { catchUpPaused } = parseResumeInput(request.body);
    return schedules.resume(idParam(request.params), catchUpPaused) ?? reply.code(404).send({ error: "找不到排程" });
  });
  app.post("/api/schedules/:id/archive", async (request, reply) => schedules.archive(idParam(request.params)) ?? reply.code(404).send({ error: "找不到排程" }));
  app.post("/api/schedules/:id/run-next", async (request) => {
    const scheduledFor = (request.body as { scheduledFor?: unknown } | null)?.scheduledFor;
    if (typeof scheduledFor !== "string" || !DateTime.fromISO(scheduledFor, { setZone: true }).isValid) {
      throw new Error("必須明確提供有效的 scheduledFor");
    }
    return executions.runNext(idParam(request.params), scheduledFor);
  });
  app.delete("/api/schedules/:id", async (request, reply) => {
    const removed = schedules.remove(idParam(request.params));
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "找不到排程" });
  });

  app.get("/api/executions", async (request) => {
    const query = request.query as { limit?: string; date?: string; schedule?: string; scheduleId?: string; status?: string };
    if (query.date) {
      const parsed = DateTime.fromISO(query.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || !parsed.isValid || parsed.toISODate() !== query.date) {
        throw new Error("date filter 必須是有效的 YYYY-MM-DD");
      }
    }
    return executions.list({
      limit: query.limit ? Number(query.limit) : 100,
      ...(query.date ? { date: query.date } : {}),
      ...((query.scheduleId ?? query.schedule) ? { scheduleId: query.scheduleId ?? query.schedule! } : {}),
      ...(query.status ? { status: query.status as ExecutionStatus } : {}),
    });
  });
  app.post("/api/executions/:id/confirm", async (request, reply) => (await executions.confirm(idParam(request.params))) ?? reply.code(404).send({ error: "找不到執行紀錄" }));
  app.post("/api/executions/:id/skip", async (request, reply) => executions.skip(idParam(request.params)) ?? reply.code(404).send({ error: "找不到執行紀錄" }));
  app.post("/api/executions/:id/retry", async (request, reply) => (await executions.retry(idParam(request.params))) ?? reply.code(404).send({ error: "找不到執行紀錄" }));
  app.post("/api/executions/:id/verify", async (request, reply) => (await executions.verify(idParam(request.params))) ?? reply.code(404).send({ error: "找不到執行紀錄" }));

  app.get("/api/adapter", async () => ({ mode: adapter.mode, supportsAtomicTransfer: adapter.supportsAtomicTransfer }));
  app.post("/api/adapter/test", async () => adapter.testConnection());
  app.get("/api/accounts", async () => database.all("SELECT * FROM accounts_cache ORDER BY name").map(mapAccount));
  app.post("/api/accounts/refresh", async (_request, reply) => {
    const accounts = await adapter.listAccounts();
    const now = new Date().toISOString();
    database.db.exec("BEGIN IMMEDIATE");
    try {
      database.run("DELETE FROM accounts_cache");
      for (const account of accounts) {
        database.run(
          "INSERT INTO accounts_cache(id,name,currency,source,refreshed_at) VALUES(?,?,?,?,?)",
          account.id, account.name, account.currency, account.source, now,
        );
      }
      database.db.exec("COMMIT");
    } catch (error) {
      database.db.exec("ROLLBACK");
      throw error;
    }
    return reply.send(accounts);
  });

  app.get("/api/addon/status", async (request) => {
    requireAddonRequest(request.headers.authorization);
    return {
      ok: true,
      adapterMode: adapter.mode,
      runtime: "browser-activated-addon-with-node-scheduler",
      transferSupported: false,
    };
  });

  app.post("/api/addon/accounts/sync", async (request) => {
    requireAddonRequest(request.headers.authorization);
    const raw = (request.body as { accounts?: unknown } | null)?.accounts;
    if (!Array.isArray(raw) || raw.length > 500) throw new Error("accounts 必須是最多 500 筆的陣列");
    const accounts = raw.map((item) => {
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim() : "";
      const name = typeof value.name === "string" ? value.name.trim() : "";
      const currency = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
      if (!id || id.length > 200 || !name || name.length > 200 || !/^[A-Z]{3}$/.test(currency)) {
        throw new Error("帳戶資料的 id、name 或三碼 currency 無效");
      }
      return { id, name, currency, source: "wealthfolio-addon" };
    });
    const now = new Date().toISOString();
    database.db.exec("BEGIN IMMEDIATE");
    try {
      database.run("DELETE FROM accounts_cache");
      for (const account of accounts) {
        database.run(
          "INSERT INTO accounts_cache(id,name,currency,source,refreshed_at) VALUES(?,?,?,?,?)",
          account.id, account.name, account.currency, account.source, now,
        );
      }
      database.db.exec("COMMIT");
    } catch (error) {
      database.db.exec("ROLLBACK");
      throw error;
    }
    return { accounts, syncedAt: now };
  });

  app.get("/api/addon/executions", async (request) => {
    requireAddonRequest(request.headers.authorization);
    const queue = executions.list({ limit: 500 }).filter((item) =>
      item.status === "WAITING_CONFIRMATION" || item.status === "FAILED" || item.status === "RUNNING" || item.status === "UNKNOWN",
    );
    return { executions: queue };
  });

  app.post("/api/addon/executions/:id/claim", async (request) => {
    requireAddonRequest(request.headers.authorization);
    return executions.claimForAddon(idParam(request.params));
  });

  app.post("/api/addon/executions/:id/complete", async (request) => {
    requireAddonRequest(request.headers.authorization);
    const body = request.body as { claimToken?: unknown; reference?: unknown } | null;
    if (typeof body?.claimToken !== "string" || typeof body.reference !== "string") {
      throw new Error("claimToken 與 reference 必須是字串");
    }
    return executions.completeAddonDelivery(idParam(request.params), body.claimToken, body.reference);
  });

  app.post("/api/addon/executions/:id/unknown", async (request) => {
    requireAddonRequest(request.headers.authorization);
    const body = request.body as { claimToken?: unknown; message?: unknown } | null;
    if (typeof body?.claimToken !== "string" || typeof body.message !== "string") {
      throw new Error("claimToken 與 message 必須是字串");
    }
    return executions.markAddonDeliveryUnknown(idParam(request.params), body.claimToken, body.message);
  });

  app.post("/api/addon/executions/:id/resolve", async (request) => {
    requireAddonRequest(request.headers.authorization);
    const reference = (request.body as { reference?: unknown } | null)?.reference;
    if (typeof reference !== "string") throw new Error("reference 必須是字串");
    return executions.resolveAddonDelivery(idParam(request.params), reference);
  });

  const publicRoot = path.resolve("dist/public");
  if (fs.existsSync(publicRoot)) {
    await app.register(fastifyStatic, { root: publicRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "找不到 API" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
