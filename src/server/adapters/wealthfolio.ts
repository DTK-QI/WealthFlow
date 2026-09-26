import type { AdapterActivity, WealthfolioAdapter } from "../types.js";

const UNSUPPORTED =
  "正式 Wealthfolio adapter 已安全停用：v3.8.0 已確認的是 add-on 內部 ctx.api，未確認外部 Node 程序可用的 HTTP 寫入與冪等查核契約。";

/**
 * Fail-closed placeholder. Do not add guessed URLs here. A future implementation must
 * pin a Wealthfolio release, authenticate a supported bridge, and prove idempotent lookup.
 */
export class OfficialWealthfolioAdapter implements WealthfolioAdapter {
  readonly mode = "wealthfolio" as const;
  readonly supportsAtomicTransfer = false;
  async testConnection() { return { ok: false, message: UNSUPPORTED }; }
  async listAccounts(): Promise<never> { throw new Error(UNSUPPORTED); }
  async createActivity(_activity: AdapterActivity, _idempotencyKey: string): Promise<never> { throw new Error(UNSUPPORTED); }
  async createTransfer(_activity: AdapterActivity, _idempotencyKey: string): Promise<never> {
    throw new Error("Wealthfolio v3.8.0 add-on SDK 沒有原子 transfer-pair API，外部 Node 程序也不能呼叫 ctx.api，因此轉帳停用。");
  }
  async lookup(_idempotencyKey: string) { return { state: "UNSUPPORTED" as const }; }
}
