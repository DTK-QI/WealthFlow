import { DateTime, IANAZone } from "luxon";
import type { Frequency, MonthlyMissingDayPolicy } from "./types.js";

export const DEFAULT_TIME_ZONE = "Asia/Taipei";

export interface CalendarRule {
  frequency: Frequency;
  interval: number;
  timeZone: string;
  startDate: string;
  endDate: string | null;
  localTime: string;
  weekday: number | null;
  dayOfMonth: number | null;
  monthlyMissingDayPolicy: MonthlyMissingDayPolicy;
}

function localCandidate(date: DateTime, localTime: string): DateTime {
  const [hour, minute] = localTime.split(":").map(Number);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

function startOfRule(rule: CalendarRule): DateTime {
  return DateTime.fromISO(rule.startDate, { zone: rule.timeZone }).startOf("day");
}

function monthCandidate(rule: CalendarRule, month: DateTime): DateTime | null {
  const days = month.daysInMonth ?? 0;
  if (rule.dayOfMonth! > days && rule.monthlyMissingDayPolicy === "SKIP") return null;
  const day = Math.min(rule.dayOfMonth!, days);
  return localCandidate(month.startOf("month").set({ day }), rule.localTime);
}

function isWithinEnd(rule: CalendarRule, candidate: DateTime): boolean {
  return !rule.endDate || candidate.toISODate()! <= rule.endDate;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function firstOccurrence(rule: CalendarRule): DateTime | null {
  const start = startOfRule(rule);
  if (rule.frequency === "DAILY") return localCandidate(start, rule.localTime);
  if (rule.frequency === "WEEKLY") {
    const daysAhead = (rule.weekday! - start.weekday + 7) % 7;
    return localCandidate(start.plus({ days: daysAhead }), rule.localTime);
  }
  let month = start.startOf("month");
  // The first monthly occurrence may be before startDate; advance by the configured interval.
  for (let guard = 0; guard < 4800; guard += 1) {
    const candidate = monthCandidate(rule, month);
    if (candidate && candidate >= start) return candidate;
    month = month.plus({ months: rule.interval });
  }
  throw new Error("無法在有效範圍內計算每月排程");
}

function parseAfter(after: DateTime | string | Date): DateTime {
  const result = typeof after === "string"
    ? DateTime.fromISO(after, { setZone: true })
    : after instanceof Date
      ? DateTime.fromJSDate(after)
      : after;
  if (!result.isValid) throw new Error(result.invalidExplanation ?? "無效的基準時間");
  return result;
}

export function validateCalendarRule(rule: CalendarRule): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.localTime)) throw new Error("執行時間格式必須是 HH:mm");
  if (!Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000) {
    throw new Error("間隔必須是 1 到 1000 的整數");
  }
  if (!IANAZone.isValidZone(rule.timeZone)) throw new Error("timeZone 必須是有效的 IANA 時區");
  const start = DateTime.fromISO(rule.startDate, { zone: rule.timeZone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.startDate) || !start.isValid || start.toISODate() !== rule.startDate) {
    throw new Error("startDate 必須是有效的 YYYY-MM-DD 日期");
  }
  if (rule.endDate) {
    const end = DateTime.fromISO(rule.endDate, { zone: rule.timeZone });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.endDate) || !end.isValid || end.toISODate() !== rule.endDate) {
      throw new Error("endDate 必須是有效的 YYYY-MM-DD 日期");
    }
    if (rule.endDate < rule.startDate) throw new Error("endDate 不可早於 startDate");
  }
  if (rule.frequency === "WEEKLY" && (!Number.isInteger(rule.weekday) || rule.weekday! < 1 || rule.weekday! > 7)) {
    throw new Error("每週排程必須指定 1 到 7 的星期");
  }
  if (rule.frequency !== "WEEKLY" && rule.weekday !== null) throw new Error("只有每週排程可指定 weekday");
  if (rule.frequency === "MONTHLY" && (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth! < 1 || rule.dayOfMonth! > 31)) {
    throw new Error("每月排程必須指定 1 到 31 的日期");
  }
  if (rule.frequency !== "MONTHLY" && rule.dayOfMonth !== null) throw new Error("只有每月排程可指定 dayOfMonth");
  if (rule.monthlyMissingDayPolicy !== "LAST_DAY" && rule.monthlyMissingDayPolicy !== "SKIP") {
    throw new Error("monthlyMissingDayPolicy 必須是 LAST_DAY 或 SKIP");
  }
  if (rule.frequency === "MONTHLY" && rule.monthlyMissingDayPolicy === "SKIP" && rule.dayOfMonth! > 28) {
    const startMonth = start.startOf("month");
    const monthCycle = 12 / greatestCommonDivisor(rule.interval, 12);
    let hasValidMonth = Array.from({ length: monthCycle }, (_, index) => startMonth.plus({ months: index * rule.interval }))
      .some((month) => (month.daysInMonth ?? 0) >= rule.dayOfMonth!);
    if (!hasValidMonth && rule.dayOfMonth === 29 && rule.interval % 12 === 0) {
      const yearStep = rule.interval / 12;
      const yearCycle = 400 / greatestCommonDivisor(yearStep, 400);
      hasValidMonth = Array.from({ length: yearCycle }, (_, index) => startMonth.plus({ years: index * yearStep }))
        .some((month) => (month.daysInMonth ?? 0) >= 29);
    }
    if (!hasValidMonth) throw new Error("此 interval 與日期組合在 SKIP 策略下永遠不會發生");
  }
}

/** Returns the first occurrence strictly after `after`, in ISO UTC, or null after endDate. */
export function nextOccurrence(rule: CalendarRule, after: DateTime | string | Date = new Date()): string | null {
  validateCalendarRule(rule);
  const localAfter = parseAfter(after).setZone(rule.timeZone);
  const first = firstOccurrence(rule);
  if (!first) return null;
  let candidate: DateTime;

  if (rule.frequency === "DAILY") {
    const elapsedDays = Math.floor(localAfter.startOf("day").diff(first.startOf("day"), "days").days);
    const periods = Math.max(0, Math.floor(elapsedDays / rule.interval));
    candidate = first.plus({ days: periods * rule.interval });
    while (candidate <= localAfter) candidate = candidate.plus({ days: rule.interval });
  } else if (rule.frequency === "WEEKLY") {
    const elapsedWeeks = Math.floor(localAfter.startOf("day").diff(first.startOf("day"), "weeks").weeks);
    const periods = Math.max(0, Math.floor(elapsedWeeks / rule.interval));
    candidate = first.plus({ weeks: periods * rule.interval });
    while (candidate <= localAfter) candidate = candidate.plus({ weeks: rule.interval });
  } else {
    const startMonth = startOfRule(rule).startOf("month");
    const elapsedMonths = (localAfter.year - startMonth.year) * 12 + localAfter.month - startMonth.month;
    let period = Math.max(0, Math.floor(elapsedMonths / rule.interval));
    for (let guard = 0; guard < 4800; guard += 1, period += 1) {
      const value = monthCandidate(rule, startMonth.plus({ months: period * rule.interval }));
      if (value && value >= first && value > localAfter) {
        candidate = value;
        if (!isWithinEnd(rule, candidate)) return null;
        return candidate.toUTC().toISO({ suppressMilliseconds: true });
      }
    }
    throw new Error("無法在有效範圍內計算下一次每月排程");
  }

  if (!candidate.isValid) throw new Error(candidate.invalidExplanation ?? "無法計算下一次執行時間");
  if (!isWithinEnd(rule, candidate)) return null;
  return candidate.toUTC().toISO({ suppressMilliseconds: true });
}

export function futureOccurrences(rule: CalendarRule, count = 5, after: DateTime | string | Date = new Date()): string[] {
  const result: string[] = [];
  let cursor: DateTime | string | Date = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextOccurrence(rule, cursor);
    if (!next) break;
    result.push(next);
    cursor = next;
  }
  return result;
}

export function occurrenceDate(iso: string, timeZone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(timeZone).toISODate()!;
}
