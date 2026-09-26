import { Decimal } from "decimal.js";
import { DEFAULT_TIME_ZONE, validateCalendarRule } from "./calendar.js";
import {
  activityKinds,
  catchUpPolicies,
  monthlyMissingDayPolicies,
  scheduleFrequencies,
  type ScheduleInput,
} from "./types.js";

function requiredString(value: unknown, field: string, max = 120): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field}不可空白`);
  if (value.trim().length > max) throw new Error(`${field}過長`);
  return value.trim();
}

function optionalString(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new Error("文字欄位格式錯誤或過長");
  return value.trim() || null;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field}必須是布林值`);
  return value;
}

export function parseScheduleInput(body: unknown): ScheduleInput {
  if (!body || typeof body !== "object") throw new Error("請提供排程內容");
  const input = body as Record<string, unknown>;
  const frequency = requiredString(input.frequency, "頻率") as ScheduleInput["frequency"];
  const activityKind = requiredString(input.activityKind, "交易類型") as ScheduleInput["activityKind"];
  if (!scheduleFrequencies.includes(frequency)) throw new Error("不支援的頻率");
  if (!activityKinds.includes(activityKind)) throw new Error("第一版只支援 DEPOSIT 與 TRANSFER");

  const rawAmount = requiredString(input.amount, "金額", 80);
  let amount: string;
  try {
    const decimal = new Decimal(rawAmount);
    if (!decimal.isFinite() || decimal.lte(0) || decimal.decimalPlaces() > 18) throw new Error();
    amount = decimal.toFixed();
  } catch {
    throw new Error("金額必須是大於零且小數位不超過 18 位的十進位數");
  }

  const interval = input.interval === undefined ? 1 : Number(input.interval);
  const timeZone = input.timeZone === undefined ? DEFAULT_TIME_ZONE : requiredString(input.timeZone, "時區", 80);
  const startDate = requiredString(input.startDate, "開始日期", 10);
  const endDate = optionalString(input.endDate, 10);
  const weekday = frequency === "WEEKLY" ? Number(input.weekday) : null;
  const dayOfMonth = frequency === "MONTHLY" ? Number(input.dayOfMonth) : null;
  const localTime = requiredString(input.localTime, "執行時間", 5);
  const monthlyMissingDayPolicy = (input.monthlyMissingDayPolicy ?? "LAST_DAY") as ScheduleInput["monthlyMissingDayPolicy"];
  if (!monthlyMissingDayPolicies.includes(monthlyMissingDayPolicy)) {
    throw new Error("monthlyMissingDayPolicy 必須是 LAST_DAY 或 SKIP");
  }
  validateCalendarRule({
    frequency, interval, timeZone, startDate, endDate, localTime, weekday, dayOfMonth, monthlyMissingDayPolicy,
  });

  const accountId = requiredString(input.accountId, "來源帳戶");
  const destinationAccountId = activityKind === "TRANSFER" ? requiredString(input.destinationAccountId, "目的帳戶") : null;
  if (destinationAccountId === accountId) throw new Error("轉出與轉入帳戶不可相同");
  const currency = requiredString(input.currency, "幣別", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("幣別必須是三碼英文字母");

  const autoPostInput = optionalBoolean(input.autoPost, "autoPost");
  const confirmationInput = optionalBoolean(input.requireConfirmation, "requireConfirmation");
  const autoPost = autoPostInput ?? (confirmationInput === undefined ? false : !confirmationInput);
  const requireConfirmation = confirmationInput ?? !autoPost;
  if (autoPost === requireConfirmation) {
    throw new Error("autoPost 與 requireConfirmation 必須互補：自動入帳或等待確認只能擇一");
  }
  const catchUpPolicy = (input.catchUpPolicy ?? "BACKFILL") as ScheduleInput["catchUpPolicy"];
  if (!catchUpPolicies.includes(catchUpPolicy)) throw new Error("catchUpPolicy 必須是 BACKFILL 或 SKIP");

  return {
    name: requiredString(input.name, "名稱"), frequency, interval, timeZone, startDate, endDate,
    localTime, weekday, dayOfMonth, monthlyMissingDayPolicy, accountId, destinationAccountId,
    activityKind, amount, currency, symbol: null, note: optionalString(input.note, 500),
    autoPost, requireConfirmation, catchUpPolicy,
  };
}

export function parseResumeInput(body: unknown): { catchUpPaused: boolean } {
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).catchUpPaused !== "boolean") {
    throw new Error("resume body 必須明確提供 catchUpPaused 布林值");
  }
  return { catchUpPaused: (body as { catchUpPaused: boolean }).catchUpPaused };
}
