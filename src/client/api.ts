export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";
export type ScheduleStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type ActivityKind = "DEPOSIT" | "TRANSFER";
export type MonthlyMissingDayPolicy = "LAST_DAY" | "SKIP";
export type CatchUpPolicy = "BACKFILL" | "SKIP";
export type ExecutionStatus = "WAITING_CONFIRMATION" | "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "UNKNOWN";

export interface Account { id: string; name: string; currency: string; source: string }
export interface Schedule {
  id: string; name: string; status: ScheduleStatus; frequency: Frequency; interval: number; timeZone: string;
  startDate: string; endDate: string | null; localTime: string; weekday: number | null; dayOfMonth: number | null;
  monthlyMissingDayPolicy: MonthlyMissingDayPolicy; accountId: string; destinationAccountId: string | null;
  activityKind: ActivityKind; amount: string; currency: string; symbol: null; note: string | null;
  autoPost: boolean; requireConfirmation: boolean; catchUpPolicy: CatchUpPolicy;
  nextRunAt: string | null; pausedAt: string | null; futureRuns: string[];
}
export interface Execution {
  id: string; scheduleId: string; scheduleName?: string; scheduledFor: string; status: ExecutionStatus;
  amount: string; currency: string; activityKind: ActivityKind;
  scheduleSnapshot: { timeZone: string };
  attempt: number; adapterReference: string | null; errorMessage: string | null;
}
export interface Dashboard {
  activeSchedules: number; executionCounts: Partial<Record<ExecutionStatus, number>>;
  nextRun: { at: string; name: string } | null;
}
export interface ScheduleDraft {
  name: string; frequency: Frequency; interval: number; timeZone: string; startDate: string; endDate: string;
  localTime: string; weekday: number; dayOfMonth: number; monthlyMissingDayPolicy: MonthlyMissingDayPolicy;
  accountId: string; destinationAccountId: string; activityKind: ActivityKind; amount: string;
  currency: string; note: string; autoPost: boolean; requireConfirmation: boolean; catchUpPolicy: CatchUpPolicy;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body === undefined ? init?.headers : { "content-type": "application/json", ...init?.headers };
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface ExecutionFilters { date?: string; schedule?: string; status?: ExecutionStatus | "" }

export const api = {
  dashboard: () => request<Dashboard>("/api/dashboard"),
  schedules: () => request<Schedule[]>("/api/schedules"),
  previewSchedule: (draft: ScheduleDraft) => request<{ futureRuns: string[] }>("/api/schedules/preview", { method: "POST", body: JSON.stringify(draft) }),
  saveSchedule: (draft: ScheduleDraft, id?: string) => request<Schedule>(id ? `/api/schedules/${id}` : "/api/schedules", { method: id ? "PUT" : "POST", body: JSON.stringify(draft) }),
  scheduleAction: (id: string, action: "pause" | "archive") => request<Schedule>(`/api/schedules/${id}/${action}`, { method: "POST" }),
  resumeSchedule: (id: string, catchUpPaused: boolean) => request<Schedule>(`/api/schedules/${id}/resume`, { method: "POST", body: JSON.stringify({ catchUpPaused }) }),
  runNext: (id: string, scheduledFor: string) => request<Execution>(`/api/schedules/${id}/run-next`, { method: "POST", body: JSON.stringify({ scheduledFor }) }),
  executions: (filters: ExecutionFilters = {}) => {
    const query = new URLSearchParams();
    if (filters.date) query.set("date", filters.date);
    if (filters.schedule) query.set("scheduleId", filters.schedule);
    if (filters.status) query.set("status", filters.status);
    return request<Execution[]>(`/api/executions${query.size ? `?${query}` : ""}`);
  },
  executionAction: (id: string, action: "confirm" | "skip" | "retry" | "verify") => request<Execution>(`/api/executions/${id}/${action}`, { method: "POST" }),
  accounts: () => request<Account[]>("/api/accounts"),
  refreshAccounts: () => request<Account[]>("/api/accounts/refresh", { method: "POST" }),
  adapter: () => request<{ mode: "mock" | "wealthfolio" | "wealthfolio_bridge" | "wealthfolio_addon"; supportsAtomicTransfer: boolean }>("/api/adapter"),
  testAdapter: () => request<{ ok: boolean; message: string }>("/api/adapter/test", { method: "POST" }),
};
