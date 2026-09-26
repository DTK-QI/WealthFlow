import { describe, expect, it } from "vitest";
import { findStableActivity, normalizeBaseUrl, parseJsonBody, toActivityCreate, type AddonClaim } from "./core";

const claim: AddonClaim = {
  claimToken: "lease",
  leaseUntil: "2026-09-26T00:02:00.000Z",
  execution: {
    id: "6f15a341-c77e-4f61-8c6f-93604f8fbb51", scheduleId: "schedule", scheduleName: "每月存款",
    scheduledFor: "2026-09-26T00:00:00.000Z", status: "WAITING_CONFIRMATION", amount: "1000.00",
    currency: "TWD", activityKind: "DEPOSIT", attempt: 0, errorMessage: null,
    scheduleSnapshot: { accountId: "cash", timeZone: "Asia/Taipei" },
  },
  activity: {
    id: "6f15a341-c77e-4f61-8c6f-93604f8fbb51", accountId: "cash", activityType: "DEPOSIT",
    activityDate: "2026-09-26", amount: "1000.00", currency: "TWD", comment: "[wealthflow:key]",
  },
};

describe("native addon delivery core", () => {
  it("accepts only clean HTTPS origins", () => {
    expect(normalizeBaseUrl("https://flow.example.com/")).toBe("https://flow.example.com");
    expect(() => normalizeBaseUrl("http://127.0.0.1:3000")).toThrow("HTTPS");
    expect(() => normalizeBaseUrl("https://user:pass@flow.example.com")).toThrow("不可包含");
  });

  it("uses the execution UUID as the stable Wealthfolio activity id", () => {
    expect(toActivityCreate(claim)).toMatchObject({
      id: claim.execution.id, activityType: "DEPOSIT", amount: "1000.00", status: "POSTED",
    });
    expect(findStableActivity([{ id: claim.execution.id, accountId: "cash", activityType: "DEPOSIT", currency: "TWD" }], claim.execution.id)?.id)
      .toBe(claim.execution.id);
  });

  it("keeps HTTP errors explicit", () => {
    expect(parseJsonBody<{ ok: boolean }>(200, '{"ok":true}')).toEqual({ ok: true });
    expect(() => parseJsonBody(409, '{"error":"lease expired"}')).toThrow("lease expired");
    expect(() => parseJsonBody(500, "not-json")).toThrow("非 JSON");
  });
});
