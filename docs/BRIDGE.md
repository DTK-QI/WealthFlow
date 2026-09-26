# 舊 `wealthfolio_bridge` 相容入口

`ADAPTER_MODE=wealthfolio_bridge` 保留給既有、已自行驗證的外部 bridge service。它不是 Wealthfolio v3.8.0 原生 add-on 的架構，也不代表 add-on 可以 HTTP listen 或在瀏覽器關閉後長駐。

新部署應使用：

```env
ADAPTER_MODE=wealthfolio_addon
WEALTHFLOW_ADDON_TOKEN=<至少 24 字元的隨機 token>
```

並依 [`bridge-addon/README.md`](../bridge-addon/README.md) 打包、安裝原生 add-on。背景 calendar、SQLite ledger、lease 與 UNKNOWN 仍在獨立 Node service；原生 add-on 只在使用者開啟 Wealthfolio 頁面時進行明確交付與查核。

舊模式的 HTTP contract 仍由 `src/server/adapters/bridge.ts` 定義：`GET /health`、`GET /accounts`、兩個 activity create endpoint 與 lookup。專案不再提供或暗示可在 Wealthfolio add-on 內實作這個 HTTP server。若沒有一個獨立、受支援且實機驗證過的 service，請勿啟用舊模式。
