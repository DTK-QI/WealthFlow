export const scheduleFrequencies = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export const scheduleStatuses = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export const activityKinds = ["DEPOSIT", "TRANSFER"] as const;
export const monthlyMissingDayPolicies = ["LAST_DAY", "SKIP"] as const;
export const catchUpPolicies = ["BACKFILL", "SKIP"] as const;
export const executionStatuses = [
  "WAITING_CONFIRMATION",
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "UNKNOWN",
] as const;

export type Frequency = (typeof scheduleFrequencies)[number];
export type ScheduleStatus = (typeof scheduleStatuses)[number];
export type ActivityKind = (typeof activityKinds)[number];
export type ExecutionStatus = (typeof executionStatuses)[number];
export type MonthlyMissingDayPolicy = (typeof monthlyMissingDayPolicies)[number];
export type CatchUpPolicy = (typeof catchUpPolicies)[number];

export interface Schedule {
  id: string;
  name: string;
  status: ScheduleStatus;
  frequency: Frequency;
  interval: number;
  timeZone: string;
  startDate: string;
  endDate: string | null;
  localTime: string;
  weekday: number | null;
  dayOfMonth: number | null;
  monthlyMissingDayPolicy: MonthlyMissingDayPolicy;
  accountId: string;
  destinationAccountId: string | null;
  activityKind: ActivityKind;
  amount: string;
  currency: string;
  symbol: string | null;
  note: string | null;
  autoPost: boolean;
  requireConfirmation: boolean;
  catchUpPolicy: CatchUpPolicy;
  nextRunAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInput {
  name: string;
  frequency: Frequency;
  interval: number;
  timeZone: string;
  startDate: string;
  endDate: string | null;
  localTime: string;
  weekday: number | null;
  dayOfMonth: number | null;
  monthlyMissingDayPolicy: MonthlyMissingDayPolicy;
  accountId: string;
  destinationAccountId: string | null;
  activityKind: ActivityKind;
  amount: string;
  currency: string;
  symbol: string | null;
  note: string | null;
  autoPost: boolean;
  requireConfirmation: boolean;
  catchUpPolicy: CatchUpPolicy;
}

export type ScheduleSnapshot = Omit<Schedule, "status" | "nextRunAt" | "pausedAt" | "createdAt" | "updatedAt">;

export interface Execution {
  id: string;
  scheduleId: string;
  scheduleName: string | undefined;
  amount: string;
  currency: string;
  activityKind: ActivityKind;
  scheduleSnapshot: ScheduleSnapshot;
  scheduledFor: string;
  status: ExecutionStatus;
  attempt: number;
  idempotencyKey: string;
  adapterReference: string | null;
  errorMessage: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface Account {
  id: string;
  name: string;
  currency: string;
  source: string;
}

export interface AdapterActivity {
  accountId: string;
  destinationAccountId?: string | null;
  activityKind: ActivityKind;
  amount: string;
  currency: string;
  symbol?: string | null;
  note?: string | null;
  activityDate: string;
}

export interface AdapterResult {
  reference: string;
}

export interface LookupResult {
  state: "FOUND" | "NOT_FOUND" | "UNSUPPORTED";
  reference?: string;
}

export interface WealthfolioAdapter {
  readonly mode: "mock" | "wealthfolio" | "wealthfolio_bridge" | "wealthfolio_addon";
  readonly supportsAtomicTransfer: boolean;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  listAccounts(): Promise<Account[]>;
  createActivity(activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult>;
  createTransfer(activity: AdapterActivity, idempotencyKey: string): Promise<AdapterResult>;
  lookup(idempotencyKey: string): Promise<LookupResult>;
}
