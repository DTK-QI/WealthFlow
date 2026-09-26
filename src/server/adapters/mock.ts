import { randomUUID } from "node:crypto";
import { AppDatabase } from "../database.js";
import type { Account, AdapterActivity, AdapterResult, LookupResult, WealthfolioAdapter } from "../types.js";

const MOCK_ACCOUNTS: Account[] = [
  { id: "mock-cash-twd", name: "日常現金帳戶", currency: "TWD", source: "mock" },
  { id: "mock-invest-usd", name: "海外投資帳戶", currency: "USD", source: "mock" },
  { id: "mock-savings-twd", name: "長期儲蓄帳戶", currency: "TWD", source: "mock" },
];

export class MockWealthfolioAdapter implements WealthfolioAdapter {
  readonly mode = "mock" as const;
  readonly supportsAtomicTransfer = true;
  constructor(private readonly database: AppDatabase) {}

  async testConnection() { return { ok: true, message: "Mock adapter 已就緒；資料只寫入本機 mock_activities。" }; }
  async listAccounts() { return MOCK_ACCOUNTS; }

  async createActivity(activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult> {
    return this.persist(activity, idempotencyKey);
  }

  async createTransfer(activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult> {
    if (!activity.destinationAccountId) throw new Error("轉帳缺少目的帳戶");
    return this.persist(activity, idempotencyKey);
  }

  async lookup(idempotencyKey: string): Promise<LookupResult> {
    const found = this.database.get("SELECT id FROM mock_activities WHERE idempotency_key=?", idempotencyKey);
    return found ? { state: "FOUND", reference: String(found.id) } : { state: "NOT_FOUND" };
  }

  private persist(activity: AdapterActivity, idempotencyKey: string): AdapterResult {
    const existing = this.database.get("SELECT id FROM mock_activities WHERE idempotency_key=?", idempotencyKey);
    if (existing) return { reference: String(existing.id) };
    const id = `mock-${randomUUID()}`;
    this.database.run(
      "INSERT INTO mock_activities(id, idempotency_key, payload, created_at) VALUES (?, ?, ?, ?)",
      id, idempotencyKey, JSON.stringify(activity), new Date().toISOString(),
    );
    return { reference: id };
  }
}
