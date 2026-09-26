import type { AppConfig } from "../config.js";
import type { Account, AdapterActivity, AdapterResult, LookupResult, WealthfolioAdapter } from "../types.js";

interface BridgeEnvelope<T> { data?: T; accounts?: Account[]; reference?: string; state?: LookupResult["state"] }

const DEFAULT_TIMEOUT_MS = 15_000;

function normalizeBaseUrl(url: string | null): string {
  if (!url) throw new Error("WEALTHFOLIO_BRIDGE_URL 尚未設定");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error("WEALTHFOLIO_BRIDGE_URL 必須是有效的 http(s) URL");
  }
}

function requireToken(token: string | null): string {
  if (!token) throw new Error("WEALTHFOLIO_BRIDGE_TOKEN 尚未設定");
  if (token.length < 24) throw new Error("WEALTHFOLIO_BRIDGE_TOKEN 至少需要 24 個字元");
  return token;
}

function bridgeError(status: number, body: unknown): Error {
  const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `Bridge HTTP ${status}`;
  return new Error(`Wealthfolio bridge 回應錯誤：${message}`);
}

export class WealthfolioBridgeAdapter implements WealthfolioAdapter {
  readonly mode = "wealthfolio_bridge" as const;
  readonly supportsAtomicTransfer = true;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: Pick<AppConfig, "wealthfolioBridgeUrl" | "wealthfolioBridgeToken" | "executionTimeoutMs">) {
    this.baseUrl = normalizeBaseUrl(config.wealthfolioBridgeUrl);
    this.token = requireToken(config.wealthfolioBridgeToken);
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const result = await this.request<{ ok?: boolean; message?: string }>("/health", { method: "GET" });
    return { ok: result.ok !== false, message: result.message ?? "Wealthfolio bridge 已連線" };
  }

  async listAccounts(): Promise<Account[]> {
    const result = await this.request<Account[] | BridgeEnvelope<Account[]>>("/accounts", { method: "GET" });
    if (Array.isArray(result)) return result;
    if (Array.isArray(result.accounts)) return result.accounts;
    if (Array.isArray(result.data)) return result.data;
    throw new Error("Bridge /accounts 回應格式錯誤");
  }

  async createActivity(activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult> {
    if (activity.activityKind !== "DEPOSIT") throw new Error("Bridge v1 只允許 DEPOSIT 透過 createActivity 寫入");
    return this.create("/activities/deposit", activity, idempotencyKey);
  }

  async createTransfer(activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult> {
    if (!activity.destinationAccountId) throw new Error("轉帳缺少目的帳戶");
    return this.create("/activities/transfer", activity, idempotencyKey);
  }

  async lookup(idempotencyKey: string): Promise<LookupResult> {
    const result = await this.request<LookupResult>(`/activities/lookup/${encodeURIComponent(idempotencyKey)}`, { method: "GET" });
    if (result.state !== "FOUND" && result.state !== "NOT_FOUND" && result.state !== "UNSUPPORTED") {
      throw new Error("Bridge lookup 回應格式錯誤");
    }
    return result;
  }

  private async create(path: string, activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult> {
    const result = await this.request<AdapterResult | BridgeEnvelope<AdapterResult>>(path, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey, activity }),
    });
    const reference = "reference" in result ? result.reference : result.data?.reference;
    if (!reference) throw new Error("Bridge create 回應缺少 reference");
    return { reference };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) throw bridgeError(response.status, body);
    return body as T;
  }
}
