import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../database.js";
import { mapAccount } from "../database.js";
import type { AdapterActivity, AdapterResult, WealthfolioAdapter } from "../types.js";

const DELIVERY_ONLY =
  "Wealthfolio add-on 模式只由 Node scheduler 產生待交付紀錄；請在 Wealthfolio 的 WealthFlow add-on 中明確確認，外部 Node 程序不能呼叫 ctx.api。";

export class WealthfolioAddonAdapter implements WealthfolioAdapter {
  readonly mode = "wealthfolio_addon" as const;
  readonly supportsAtomicTransfer = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly config: Pick<AppConfig, "wealthflowAddonToken">,
  ) {
    const token = config.wealthflowAddonToken;
    if (!token || token.length < 24) {
      throw new Error("ADAPTER_MODE=wealthfolio_addon 時，WEALTHFLOW_ADDON_TOKEN 至少需要 24 個字元");
    }
  }

  async testConnection() {
    return {
      ok: true,
      message: "Node scheduler 已就緒；add-on 是否已安裝與獲准連線，需從 Wealthfolio add-on 頁面驗證。",
    };
  }

  async listAccounts() {
    return this.database.all("SELECT * FROM accounts_cache ORDER BY name").map(mapAccount);
  }

  async createActivity(_activity: AdapterActivity, _idempotencyKey: string): Promise<AdapterResult> {
    throw new Error(DELIVERY_ONLY);
  }

  async createTransfer(_activity: AdapterActivity, _idempotencyKey: string): Promise<AdapterResult> {
    throw new Error("Wealthfolio v3.8.0 add-on SDK 沒有原子 transfer-pair API，正式 add-on 路徑停用轉帳。");
  }

  async lookup(_idempotencyKey: string) {
    return { state: "UNSUPPORTED" as const };
  }
}
