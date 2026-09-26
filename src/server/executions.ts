import { createHash, randomUUID } from "node:crypto";
import { nextOccurrence, occurrenceDate } from "./calendar.js";
import type { AppConfig } from "./config.js";
import { AppDatabase, mapExecution, mapSchedule, scheduleSnapshot } from "./database.js";
import { executionStatuses, type Execution, type ExecutionStatus, type Schedule, type ScheduleSnapshot, type WealthfolioAdapter } from "./types.js";

const executionSelect = `SELECT e.*, s.name AS schedule_name FROM executions e
JOIN schedules s ON s.id=e.schedule_id`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ExecutionFilters {
  limit?: number;
  date?: string;
  scheduleId?: string;
  status?: ExecutionStatus;
}

export interface AddonExecutionClaim {
  claimToken: string;
  leaseUntil: string;
  execution: Execution;
  activity: {
    id: string;
    accountId: string;
    activityType: "DEPOSIT";
    activityDate: string;
    amount: string;
    currency: string;
    comment: string;
  };
}

export class ExecutionService {
  readonly workerId = randomUUID();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly adapter: WealthfolioAdapter,
    private readonly config: Pick<AppConfig, "schedulerPollMs" | "executionTimeoutMs" | "leaseSeconds"> & { materializeBatchLimit?: number },
  ) {}

  list(filters: ExecutionFilters = {}): Execution[] {
    const requestedLimit = filters.limit ?? 100;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error("limit 必須是正整數");
    const safeLimit = Math.min(requestedLimit, 500);
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.scheduleId) { clauses.push("e.schedule_id=?"); values.push(filters.scheduleId); }
    if (filters.status) {
      if (!executionStatuses.includes(filters.status)) throw new Error("不支援的 execution status");
      clauses.push("e.status=?"); values.push(filters.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.all(`${executionSelect}${where} ORDER BY e.scheduled_for DESC`, ...values).map(mapExecution);
    const filtered = filters.date
      ? rows.filter((item) => occurrenceDate(item.scheduledFor, item.scheduleSnapshot.timeZone) === filters.date)
      : rows;
    return filtered.slice(0, safeLimit);
  }

  get(id: string): Execution | null {
    const row = this.database.get(`${executionSelect} WHERE e.id=?`, id);
    return row ? mapExecution(row) : null;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.schedulerPollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.database.run(
        `UPDATE executions SET status='UNKNOWN', error_message='程序中斷或 lease 到期；遠端結果不明，禁止自動重送',
         finished_at=?, lease_owner=NULL, lease_until=NULL WHERE status='RUNNING' AND lease_until < ?`,
        now.toISOString(), now.toISOString(),
      );
      const due = this.database.all(
        "SELECT * FROM schedules WHERE status='ACTIVE' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 50",
        now.toISOString(),
      ).map(mapSchedule);
      for (const schedule of due) await this.materializeDue(schedule, now);
    } finally {
      this.ticking = false;
    }
  }

  private async materializeDue(initial: Schedule, now: Date): Promise<void> {
    const nowIso = now.toISOString();
    const batchLimit = Math.min(Math.max(this.config.materializeBatchLimit ?? 100, 1), 1000);
    if (initial.catchUpPolicy === "SKIP") {
      let latest = initial.nextRunAt!;
      let afterLatest = nextOccurrence(initial, latest);
      let guard = 0;
      while (afterLatest && afterLatest <= nowIso) {
        latest = afterLatest;
        afterLatest = nextOccurrence(initial, latest);
        guard += 1;
        if (guard > 1_000_000) throw new Error(`排程 ${initial.id} 的漏期數量異常`);
      }
      const withinPollingWindow = now.getTime() - Date.parse(latest) <= this.config.schedulerPollMs;
      if (!withinPollingWindow) {
        this.database.run(
          "UPDATE schedules SET next_run_at=?, updated_at=? WHERE id=? AND status='ACTIVE' AND next_run_at=?",
          afterLatest, nowIso, initial.id, initial.nextRunAt,
        );
        return;
      }
      const execution = this.materializeOne(initial, initial.nextRunAt!, latest, afterLatest, false);
      if (execution?.status === "PENDING") await this.execute(execution.id);
      return;
    }

    let schedule: Schedule | null = initial;
    for (let count = 0; count < batchLimit && schedule?.nextRunAt && schedule.nextRunAt <= nowIso; count += 1) {
      const scheduledFor = schedule.nextRunAt;
      const execution = this.materializeOne(
        schedule,
        scheduledFor,
        scheduledFor,
        nextOccurrence(schedule, scheduledFor),
        false,
      );
      if (execution?.status === "PENDING") await this.execute(execution.id);
      schedule = this.getSchedule(initial.id);
    }
  }

  private getSchedule(id: string): Schedule | null {
    const row = this.database.get("SELECT * FROM schedules WHERE id=?", id);
    return row ? mapSchedule(row) : null;
  }

  private materializeOne(
    schedule: Schedule,
    expectedNextRunAt: string,
    scheduledFor: string,
    followingRunAt: string | null,
    forcePending: boolean,
  ): Execution | null {
    const id = randomUUID();
    const key = createHash("sha256").update(`${schedule.id}:${scheduledFor}`).digest("hex");
    const now = new Date().toISOString();
    const addonDelivery = this.adapter.mode === "wealthfolio_addon";
    const status = addonDelivery ? "WAITING_CONFIRMATION" : forcePending || schedule.autoPost ? "PENDING" : "WAITING_CONFIRMATION";
    const snapshot = JSON.stringify(scheduleSnapshot(schedule));
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.get("SELECT * FROM schedules WHERE id=?", schedule.id);
      if (!current || current.next_run_at !== expectedNextRunAt || current.status !== "ACTIVE") {
        this.database.db.exec("ROLLBACK");
        return null;
      }
      this.database.run(
        `INSERT OR IGNORE INTO executions(id,schedule_id,scheduled_for,status,attempt,idempotency_key,schedule_snapshot,created_at)
         VALUES(?,?,?,?,0,?,?,?)`, id, schedule.id, scheduledFor, status, key, snapshot, now,
      );
      if (forcePending && !addonDelivery) {
        this.database.run(
          "UPDATE executions SET status='PENDING', error_message=NULL WHERE schedule_id=? AND scheduled_for=? AND status='WAITING_CONFIRMATION'",
          schedule.id, scheduledFor,
        );
      }
      this.database.run(
        "UPDATE schedules SET next_run_at=?, updated_at=? WHERE id=? AND next_run_at=?",
        followingRunAt, now, schedule.id, expectedNextRunAt,
      );
      this.database.db.exec("COMMIT");
      const row = this.database.get(`${executionSelect} WHERE e.schedule_id=? AND e.scheduled_for=?`, schedule.id, scheduledFor);
      return row ? mapExecution(row) : null;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  async runNext(scheduleId: string, scheduledFor: string): Promise<Execution> {
    const schedule = this.getSchedule(scheduleId);
    if (!schedule) throw new Error("找不到排程");
    if (schedule.status !== "ACTIVE" || !schedule.nextRunAt) throw new Error("排程目前沒有可立即執行的下一期");
    if (scheduledFor !== schedule.nextRunAt) throw new Error("scheduledFor 必須明確等於目前 nextRunAt");
    const succeeded = this.database.get(
      "SELECT id FROM executions WHERE schedule_id=? AND scheduled_for=? AND status='SUCCEEDED'",
      scheduleId, scheduledFor,
    );
    if (succeeded) throw new Error("此排程期數已成功執行，不得重複入帳");
    const execution = this.materializeOne(
      schedule,
      schedule.nextRunAt,
      schedule.nextRunAt,
      nextOccurrence(schedule, schedule.nextRunAt),
      true,
    );
    if (!execution) throw new Error("下一期已被其他 worker 取用，請重新整理");
    if (execution.status === "PENDING") await this.execute(execution.id);
    return this.get(execution.id)!;
  }

  async confirm(id: string): Promise<Execution | null> {
    if (this.adapter.mode === "wealthfolio_addon") {
      throw new Error("此模式必須在 Wealthfolio 的 WealthFlow add-on 內確認，Node 服務不具備 ctx.api");
    }
    const changed = this.database.run(
      "UPDATE executions SET status='PENDING', error_message=NULL WHERE id=? AND status='WAITING_CONFIRMATION'", id,
    ).changes;
    if (!changed) return this.get(id);
    await this.execute(id);
    return this.get(id);
  }

  skip(id: string): Execution | null {
    this.database.run(
      "UPDATE executions SET status='SKIPPED', finished_at=?, lease_owner=NULL, lease_until=NULL WHERE id=? AND status IN ('WAITING_CONFIRMATION','PENDING','FAILED')",
      new Date().toISOString(), id,
    );
    return this.get(id);
  }

  async retry(id: string): Promise<Execution | null> {
    if (this.adapter.mode === "wealthfolio_addon") {
      throw new Error("此模式必須在 Wealthfolio add-on 內先查核穩定 activity ID，再決定交付；禁止由 Node 直接重送");
    }
    const changed = this.database.run(
      "UPDATE executions SET status='PENDING', error_message=NULL, finished_at=NULL WHERE id=? AND status='FAILED'", id,
    ).changes;
    if (!changed) return this.get(id);
    await this.execute(id);
    return this.get(id);
  }

  async verify(id: string): Promise<Execution | null> {
    const execution = this.get(id);
    if (!execution || execution.status !== "UNKNOWN") return execution;
    const lookup = await this.adapter.lookup(execution.idempotencyKey);
    if (lookup.state === "FOUND") {
      this.database.run(
        "UPDATE executions SET status='SUCCEEDED', adapter_reference=?, error_message=NULL, finished_at=? WHERE id=? AND status='UNKNOWN'",
        lookup.reference ?? null, new Date().toISOString(), id,
      );
    } else {
      const message = lookup.state === "UNSUPPORTED"
        ? "Adapter 不支援安全查核；維持結果不明，禁止重送"
        : "查無結果但不能證明原請求未生效；維持結果不明，禁止重送";
      this.database.run("UPDATE executions SET error_message=? WHERE id=? AND status='UNKNOWN'", message, id);
    }
    return this.get(id);
  }

  async execute(id: string): Promise<void> {
    if (this.adapter.mode === "wealthfolio_addon") {
      throw new Error("Wealthfolio add-on 模式禁止 Node 執行 ctx.api 工作");
    }
    const now = new Date();
    const leaseMs = Math.max(this.config.leaseSeconds * 1000, this.config.executionTimeoutMs + 5_000);
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const changed = this.database.run(
      `UPDATE executions SET status='RUNNING', lease_owner=?, lease_until=?, started_at=?, attempt=attempt+1
       WHERE id=? AND status='PENDING' AND (lease_until IS NULL OR lease_until < ?)`,
      this.workerId, leaseUntil, now.toISOString(), id, now.toISOString(),
    ).changes;
    if (!changed) return;
    const row = this.database.get("SELECT * FROM executions WHERE id=?", id);
    if (!row) return;
    const snapshot = JSON.parse(String(row.schedule_snapshot)) as ScheduleSnapshot;
    const activity = {
      accountId: snapshot.accountId,
      destinationAccountId: snapshot.destinationAccountId,
      activityKind: snapshot.activityKind,
      amount: snapshot.amount,
      currency: snapshot.currency,
      symbol: snapshot.symbol,
      note: snapshot.note,
      activityDate: occurrenceDate(String(row.scheduled_for), snapshot.timeZone),
    };
    const operation = activity.activityKind === "TRANSFER"
      ? this.adapter.createTransfer(activity, String(row.idempotency_key))
      : this.adapter.createActivity(activity, String(row.idempotency_key));
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"TIMEOUT">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("TIMEOUT"), this.config.executionTimeoutMs);
    });
    try {
      const result = await Promise.race([operation, timeout]);
      if (result === "TIMEOUT") {
        this.finish(id, "UNKNOWN", null, "請求逾時，遠端可能已寫入；必須先查核，不會自動重送");
      } else {
        this.finish(id, "SUCCEEDED", result.reference, null);
      }
    } catch (error) {
      this.finish(id, "FAILED", null, errorMessage(error));
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private finish(id: string, status: "SUCCEEDED" | "FAILED" | "UNKNOWN", reference: string | null, message: string | null): void {
    this.database.run(
      `UPDATE executions SET status=?, adapter_reference=?, error_message=?, finished_at=?, lease_owner=NULL, lease_until=NULL
       WHERE id=? AND status='RUNNING' AND lease_owner=?`,
      status, reference, message, new Date().toISOString(), id, this.workerId,
    );
  }

  claimForAddon(id: string): AddonExecutionClaim {
    if (this.adapter.mode !== "wealthfolio_addon") {
      throw new Error("只有 ADAPTER_MODE=wealthfolio_addon 可使用 add-on 交付 API");
    }
    const current = this.get(id);
    if (!current) throw new Error("找不到執行紀錄");
    if (current.activityKind !== "DEPOSIT") {
      throw new Error("Wealthfolio v3.8.0 add-on SDK 沒有原子 transfer-pair API，拒絕交付轉帳");
    }
    if (current.status !== "WAITING_CONFIRMATION" && current.status !== "FAILED") {
      throw new Error(`執行狀態 ${current.status} 不能取得交付 lease`);
    }

    const claimToken = randomUUID();
    const now = new Date();
    const leaseMs = Math.max(this.config.leaseSeconds * 1000, 120_000);
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const changed = this.database.run(
      `UPDATE executions SET status='RUNNING', lease_owner=?, lease_until=?, started_at=?, finished_at=NULL,
       error_message=NULL, attempt=attempt+1
       WHERE id=? AND status IN ('WAITING_CONFIRMATION','FAILED') AND (lease_until IS NULL OR lease_until < ?)`,
      claimToken, leaseUntil, now.toISOString(), id, now.toISOString(),
    ).changes;
    if (!changed) throw new Error("執行已由其他 add-on session 取得，請重新整理");

    const execution = this.get(id)!;
    const snapshot = execution.scheduleSnapshot;
    const marker = `[wealthflow:${execution.idempotencyKey}]`;
    return {
      claimToken,
      leaseUntil,
      execution,
      activity: {
        id: execution.id,
        accountId: snapshot.accountId,
        activityType: "DEPOSIT",
        activityDate: occurrenceDate(execution.scheduledFor, snapshot.timeZone),
        amount: snapshot.amount,
        currency: snapshot.currency,
        comment: [snapshot.note, marker].filter(Boolean).join("\n"),
      },
    };
  }

  completeAddonDelivery(id: string, claimToken: string, reference: string): Execution {
    if (!claimToken || reference !== id) throw new Error("claimToken 不可空白，且 Wealthfolio reference 必須等於穩定 execution ID");
    const changed = this.database.run(
      `UPDATE executions SET status='SUCCEEDED', adapter_reference=?, error_message=NULL, finished_at=?,
       lease_owner=NULL, lease_until=NULL WHERE id=? AND status='RUNNING' AND lease_owner=?`,
      reference, new Date().toISOString(), id, claimToken,
    ).changes;
    if (!changed) throw new Error("交付 lease 已失效或不屬於此 session；不可覆寫目前狀態");
    return this.get(id)!;
  }

  markAddonDeliveryUnknown(id: string, claimToken: string, message: string): Execution {
    const detail = message.trim().slice(0, 500) || "ctx.api 結果不明；必須依穩定 activity ID 查核，禁止直接重送";
    const changed = this.database.run(
      `UPDATE executions SET status='UNKNOWN', adapter_reference=NULL, error_message=?, finished_at=?,
       lease_owner=NULL, lease_until=NULL WHERE id=? AND status='RUNNING' AND lease_owner=?`,
      detail, new Date().toISOString(), id, claimToken,
    ).changes;
    if (!changed) throw new Error("交付 lease 已失效或不屬於此 session");
    return this.get(id)!;
  }

  resolveAddonDelivery(id: string, reference: string): Execution {
    if (reference !== id) {
      throw new Error("查核 reference 必須等於 WealthFlow 提供的穩定 activity ID");
    }
    const changed = this.database.run(
      `UPDATE executions SET status='SUCCEEDED', adapter_reference=?, error_message=NULL, finished_at=?,
       lease_owner=NULL, lease_until=NULL WHERE id=? AND status IN ('UNKNOWN','RUNNING')`,
      reference, new Date().toISOString(), id,
    ).changes;
    if (!changed) throw new Error("只有 UNKNOWN 或 RUNNING 執行可由 add-on 查核完成");
    return this.get(id)!;
  }
}
