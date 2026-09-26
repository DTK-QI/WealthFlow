import { afterEach, describe, expect, it, vi } from "vitest";
import { WealthfolioBridgeAdapter } from "./bridge.js";

afterEach(() => vi.unstubAllGlobals());

describe("Wealthfolio bridge adapter", () => {
  it("uses bearer token and maps accounts, deposits, transfers and lookup", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer 123456789012345678901234");
      let body: unknown;
      let status = 200;
      if (url.pathname === "/health") body = { ok: true, message: "bridge ok" };
      else if (url.pathname === "/accounts") body = { accounts: [{ id: "bank", name: "第一銀行", currency: "TWD", source: "wealthfolio" }] };
      else if (url.pathname === "/activities/deposit" || url.pathname === "/activities/transfer") {
        seen.push(JSON.parse(String(init?.body)));
        body = { reference: url.pathname === "/activities/deposit" ? "dep-1" : "tr-1" };
      } else if (url.pathname === "/activities/lookup/key-1") body = { state: "FOUND", reference: "dep-1" };
      else { status = 404; body = { error: "missing" }; }
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }));
    const url = "https://bridge.example.test";
    const adapter = new WealthfolioBridgeAdapter({ wealthfolioBridgeUrl: url, wealthfolioBridgeToken: "123456789012345678901234", executionTimeoutMs: 1000 });
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: true });
    await expect(adapter.listAccounts()).resolves.toEqual([{ id: "bank", name: "第一銀行", currency: "TWD", source: "wealthfolio" }]);
    await expect(adapter.createActivity({ accountId: "bank", activityKind: "DEPOSIT", amount: "100", currency: "TWD", activityDate: "2026-01-01" }, "key-1")).resolves.toEqual({ reference: "dep-1" });
    await expect(adapter.createTransfer({ accountId: "bank", destinationAccountId: "wallet", activityKind: "TRANSFER", amount: "50", currency: "TWD", activityDate: "2026-01-01" }, "key-2")).resolves.toEqual({ reference: "tr-1" });
    await expect(adapter.lookup("key-1")).resolves.toEqual({ state: "FOUND", reference: "dep-1" });
    expect(seen).toHaveLength(2);
  });

  it("fails closed when bridge secret is missing or short", () => {
    expect(() => new WealthfolioBridgeAdapter({ wealthfolioBridgeUrl: "http://127.0.0.1:8791", wealthfolioBridgeToken: null, executionTimeoutMs: 1000 })).toThrow("TOKEN");
    expect(() => new WealthfolioBridgeAdapter({ wealthfolioBridgeUrl: "http://127.0.0.1:8791", wealthfolioBridgeToken: "short", executionTimeoutMs: 1000 })).toThrow("至少");
  });
});
