# Wealthfolio v3.8.0 add-on 相容性查證

查證日期：2026-09-26（Asia/Taipei）

## 固定基準與官方來源

- 官方儲存庫：<https://github.com/wealthfolio/wealthfolio>
- tag：`v3.8.0`
- tag commit：`8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b`
- 本文件的原始碼連結全部固定到以上 commit，不以會變動的 `main` 作為結論依據。

主要證據：

- [`packages/addon-sdk/src/types.ts`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/packages/addon-sdk/src/types.ts)：`AddonContext`、`ctx.api`、route 與 lifecycle 型別。
- [`packages/addon-sdk/src/host-api.ts`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/packages/addon-sdk/src/host-api.ts)：accounts、activities、storage、secrets、network 等 host API。
- [`packages/addon-sdk/src/data-types.ts`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/packages/addon-sdk/src/data-types.ts)：`ActivityCreate` 與 `ActivityDetails`。
- [`packages/addon-sdk/src/manifest.ts`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/packages/addon-sdk/src/manifest.ts)：manifest、network allow-list、contributed routes。
- [`apps/frontend/src/addons/addons-core.ts`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/apps/frontend/src/addons/addons-core.ts)：add-on 由前端載入；contributed route add-on 會 lazy activate。
- [`apps/frontend/src/addons/iframe/addon-iframe-manager.ts`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/apps/frontend/src/addons/iframe/addon-iframe-manager.ts)：瀏覽器建立 `iframe`、`sandbox="allow-scripts"`、`postMessage` RPC 與 `ctx.api` bridge。
- [`apps/frontend/src/addons/addon-runtime-loader.tsx`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/apps/frontend/src/addons/addon-runtime-loader.tsx)：使用者通過前端驗證後才呼叫 `loadAllAddons()`。
- [`apps/server/src/api/addons.rs`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/apps/server/src/api/addons.rs)：Docker/web server 提供安裝、套件載入、storage 等 API，但沒有執行 add-on JavaScript 的 worker。
- [`crates/core/src/addons/network.rs`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/crates/core/src/addons/network.rs)：broker 強制 HTTPS、無 redirect、10 秒 timeout，並拒絕 localhost、`.local`、loopback、private/link-local/ULA 位址及解析到 private IP 的 hostname。
- [`docs/addons/addon-getting-started.md`](https://github.com/wealthfolio/wealthfolio/blob/8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b/docs/addons/addon-getting-started.md)：manifest、route、build 與使用者安裝流程。

## 結論矩陣

| 問題 | v3.8.0 結論 | 證據與影響 |
| --- | --- | --- |
| Docker 中是否有 server-side add-on runtime？ | **否** | Rust server 保存/提供套件與資料；JavaScript runtime 是 frontend 建立的 sandbox iframe。 |
| 瀏覽器關閉後 add-on timer 是否繼續？ | **否** | iframe、`window` timer 與 `postMessage` bridge 都隨頁面消失。不能拿 add-on 做背景 scheduler。 |
| contributed route add-on 是否在 server/前端啟動時立即執行？ | **否** | manifest 先提供 navigation，`enable()` 延遲到首次進入 route。 |
| add-on 能否 HTTP listen？ | **沒有官方能力** | SDK 沒有 socket/listen/server API；sandbox 只有 browser API 與 host bridge。不可假設可 listen 本機 port。 |
| add-on 能否對外 HTTP request？ | **能，但只透過 broker** | `ctx.api.network.request` 只允許 manifest 宣告且安裝時核准、解析到 public IP 的 **HTTPS host**。localhost、LAN/private IP 與 `.local` 都被拒絕。這是 client request，不是 listen。 |
| add-on 能否持久儲存？ | **能** | `ctx.api.storage` 是 host SQLite-backed、按 add-on 隔離的 durable string KV；key 最長 128 字元，單值約 250 KB。它不會讓程式碼在瀏覽器關閉後執行。 |
| add-on 能否用 `ctx.api` 讀帳戶/活動？ | **能** | `accounts.getAll()`、`activities.getAll/search()` 有正式型別，需 manifest permission。 |
| add-on 能否用 `ctx.api` 寫活動？ | **能** | `activities.create/update/saveMany()` 有正式型別與 runtime permission enforcement。 |
| 外部 Node 程序能否呼叫 `ctx.api`？ | **不能** | `ctx.api` 是 host 建立並透過 iframe message bridge 注入的 context，不是外部 HTTP SDK。 |
| add-on 是否有原子 transfer-pair API？ | **v3.8.0 沒有** | 固定 commit 的 `ActivitiesAPI` 只有 get/search/create/update/saveMany/import 等；沒有 `saveTransferPair`。因此正式路徑停用轉帳。 |

## 儲存與 activity 冪等策略

`ctx.api.storage` 適合 add-on 設定，例如 WealthFlow base URL。Bearer token 使用 `ctx.api.secrets`；network request 只傳 `secretKey`，不把已保存 token 讀回 add-on JavaScript。

`ActivityCreate` 沒有公開的 `idempotencyKey` 欄位，但有可選 `id`。本整合把 Node execution UUID 當成 Wealthfolio activity `id`：

1. Node 先在 SQLite transaction materialize execution，保存 schedule snapshot 與既有 idempotency key。
2. add-on 取得有期限的 lease。
3. 寫入前先用 `activities.getAll(accountId)` 查相同 execution UUID。
4. 不存在才用該 UUID 呼叫 `activities.create()`。
5. 若 create 回應或回報 Node 的網路中斷，再查同一 UUID；查不到則標記 `UNKNOWN`，不直接重送。

此策略以 SDK 明確支持的 client-provided `ActivityCreate.id` 為基礎。它沒有把 `ctx.api` 暴露到外部，也沒有假設未公開 endpoint。

## 採用架構

```text
長駐 Node service
  calendar + validation + SQLite ledger + lease + materialize
        │  只接受已核准 HTTPS broker request
        ▼
Wealthfolio browser add-on（使用者開啟時）
  帳戶同步 + 待交付 UI + UNKNOWN 查核
        │  使用者逐筆確認
        ▼
ctx.api.activities.create / getAll
```

這是 v3.8.0 最接近「方案一」且不虛構 runtime 能力的做法。瀏覽器關閉時，Node 仍可靠保存到期 execution；不會聲稱已寫入 Wealthfolio。重新開啟後由 add-on 明確交付。

## 安裝與打包限制

官方套件是 ZIP，根目錄包含 `manifest.json` 與 manifest 指定的 `dist/addon.js`。本專案使用：

```bash
npm run build:addon
npm run package:addon -- --origin https://flow.example.com
```

`package:addon` 會把唯一 hostname 寫入套件內 `network.allowedHosts`。`http://127.0.0.1`、內網 IP、`.local` hostname，甚至 DNS 解析到 private IP 的 HTTPS hostname 都會被 v3.8.0 broker 拒絕。自架時需由反向代理提供 Wealthfolio server 可達、解析到 public IP 的 HTTPS origin。若部署政策不允許這個網路面，原生 add-on 無法連到獨立 scheduler；只能保留 Node UI/mock ledger，不可假裝已整合。

安裝：Wealthfolio → Settings → Addons → Install Addon → 選 ZIP → 審查 permissions/network host → 啟用 → 從側邊欄開啟 WealthFlow。詳細步驟見 [`bridge-addon/README.md`](../bridge-addon/README.md)。

## 尚未宣稱的事項

- 未在使用者的 Wealthfolio Docker 實例完成安裝 smoke test，因此不宣稱已部署或已連到真實帳本。
- 沒有執行任何真實 activity create。
- 沒有變更 Wealthfolio 本身或直接存取其 SQLite。
- 沒有證據支持 add-on background worker、service worker、HTTP listen 或瀏覽器關閉後 timer。
