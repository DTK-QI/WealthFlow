import type { ActivityCreate, HostActivity } from "./sdk-v3.8.0";

export type QueueStatus = "WAITING_CONFIRMATION" | "FAILED" | "RUNNING" | "UNKNOWN";

export interface QueueExecution {
  id: string;
  scheduleId: string;
  scheduleName?: string;
  scheduledFor: string;
  status: QueueStatus;
  amount: string;
  currency: string;
  activityKind: "DEPOSIT" | "TRANSFER";
  attempt: number;
  errorMessage: string | null;
  scheduleSnapshot: { accountId: string; timeZone: string; note?: string | null };
}

export interface AddonClaim {
  claimToken: string;
  leaseUntil: string;
  execution: QueueExecution;
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

export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:") throw new Error("Wealthfolio v3.8.0 network broker 只允許 HTTPS URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("服務 URL 不可包含帳密、query 或 fragment");
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function parseJsonBody<T>(status: number, body: string): T {
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`WealthFlow 回傳非 JSON 內容（HTTP ${status}）`);
  }
  if (status < 200 || status >= 300) {
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${status}`;
    throw new Error(message);
  }
  return parsed as T;
}

export function toActivityCreate(claim: AddonClaim): ActivityCreate {
  return {
    id: claim.activity.id,
    accountId: claim.activity.accountId,
    activityType: "DEPOSIT",
    activityDate: claim.activity.activityDate,
    amount: claim.activity.amount,
    currency: claim.activity.currency,
    status: "POSTED",
    needsReview: false,
    comment: claim.activity.comment,
  };
}

export function findStableActivity(activities: HostActivity[], executionId: string): HostActivity | null {
  return activities.find((activity) => activity.id === executionId) ?? null;
}

export function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? new Intl.NumberFormat("zh-TW", { style: "currency", currency, maximumFractionDigits: 8 }).format(value)
    : `${amount} ${currency}`;
}
