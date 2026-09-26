import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { futureOccurrences, nextOccurrence, type CalendarRule } from "./calendar.js";

function rule(overrides: Partial<CalendarRule> = {}): CalendarRule {
  return {
    frequency: "DAILY", interval: 1, timeZone: "Asia/Taipei", startDate: "2026-01-01", endDate: null,
    localTime: "09:00", weekday: null, dayOfMonth: null, monthlyMissingDayPolicy: "LAST_DAY", ...overrides,
  };
}

describe("time-zone calendar", () => {
  it("calculates daily occurrence using the selected local time zone", () => {
    expect(nextOccurrence(rule({ localTime: "09:30" }), "2026-01-03T02:00:00.000Z")).toBe("2026-01-04T01:30:00Z");
  });

  it("supports every N weeks and advances strictly after an occurrence", () => {
    const result = nextOccurrence(
      rule({ frequency: "WEEKLY", interval: 2, weekday: 1, startDate: "2026-09-21", localTime: "08:00" }),
      DateTime.fromISO("2026-09-21T08:00:00", { zone: "Asia/Taipei" }),
    );
    expect(result).toBe("2026-10-05T00:00:00Z");
  });

  it("clamps day 31 to month end without drifting and handles leap year", () => {
    expect(futureOccurrences(
      rule({ frequency: "MONTHLY", dayOfMonth: 31, localTime: "21:15", startDate: "2028-01-01" }),
      3,
      "2028-01-31T14:00:00Z",
    )).toEqual(["2028-02-29T13:15:00Z", "2028-03-31T13:15:00Z", "2028-04-30T13:15:00Z"]);
  });

  it("skips short months and honors inclusive endDate", () => {
    expect(futureOccurrences(
      rule({ frequency: "MONTHLY", interval: 1, dayOfMonth: 31, monthlyMissingDayPolicy: "SKIP", startDate: "2026-01-01", endDate: "2026-05-31" }),
      5,
      "2026-01-01T00:00:00Z",
    )).toEqual(["2026-01-31T01:00:00Z", "2026-03-31T01:00:00Z", "2026-05-31T01:00:00Z"]);
  });

  it("anchors every N days at startDate", () => {
    expect(futureOccurrences(rule({ interval: 3, startDate: "2026-01-02" }), 3, "2026-01-01T00:00:00Z"))
      .toEqual(["2026-01-02T01:00:00Z", "2026-01-05T01:00:00Z", "2026-01-08T01:00:00Z"]);
  });

  it("rejects a monthly SKIP combination that can never occur", () => {
    expect(() => nextOccurrence(
      rule({ frequency: "MONTHLY", interval: 12, startDate: "2026-02-01", dayOfMonth: 30, monthlyMissingDayPolicy: "SKIP" }),
      "2026-01-01T00:00:00Z",
    )).toThrow("永遠不會發生");
  });
});
