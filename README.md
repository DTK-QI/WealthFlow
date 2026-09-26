# WealthFlow

WealthFlow 是自架的繁體中文定期記帳工具。Fastify API、React UI 與 scheduler 由同一個 Node.js 程序提供；預設使用只寫本機 SQLite 的 mock adapter。

Wealthfolio `v3.8.0` 的原生 add-on runtime 已固定到 commit `8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b` 查證：它是瀏覽器 sandbox iframe，不是 Docker server worker。因此本專案採「長駐 Node scheduler + 正式可安裝 add-on」：Node 在瀏覽器關閉時仍可靠 materialize 到期紀錄；使用者開啟 add-on 後明確確認，才由 `ctx.api` 寫入。詳見 [相容性證據](docs/WEALTHFOLIO_COMPATIBILITY.md) 與 [add-on 安裝](bridge-addon/README.md)。

## 第一版範圍

- Activity 只允許 `DEPOSIT` 與具原子能力的 `TRANSFER`；舊版其他 activity 會在 migration 後封存並從排程列表隱藏。
- 日、週、月排程支援每 N 週期、IANA 時區（預設 `Asia/Taipei`）、起訖日期與未來五次預覽。
- 月排程遇不存在的日期可選 `LAST_DAY`（月底）或 `SKIP`（跳過）；日曆運算包含閏年與時區規則。
- Mock 等可由 Node 執行的模式：`autoPost=true` 才代表到期寫入；原生 `wealthfolio_addon` 模式禁止自動入帳，到期只建立 `WAITING_CONFIRMATION`，待瀏覽器開啟後逐筆確認。
- 停機漏期的 `BACKFILL` 會保留原應發生時間逐筆補記，每個 schedule/tick 受 `MATERIALIZE_BATCH_LIMIT` 限制；`SKIP` 略過超出正常輪詢視窗的逾期期數並推進到未來。
- 恢復暫停排程時必須明確選擇 `catchUpPaused`。`true` 保留暫停前游標並套用 schedule 的 catch-up policy；`false` 直接從恢復時間後重新計算。
- 每筆 execution 保存 materialize 當下的完整 schedule JSON snapshot。編輯 schedule 只改變尚未 materialize 的期數；執行與顯示金額都讀 snapshot。
- 預覽 API 不寫資料；立即執行 API 要求呼叫者帶入精確的目前 `nextRunAt`，並由唯一週期與 idempotency key 防止成功期數重複入帳。
- 轉帳建立/編輯時會以 `accounts_cache` 驗證轉出與轉入帳戶幣別都等於 schedule currency。

## 需求與啟動

- Node.js 22.5 以上（使用內建 `node:sqlite`；建議 Node.js 24）
- npm 10 以上

```bash
cp .env.example .env
npm install
npm test
npm run build
npm start
```

開發模式使用 `npm run dev`：API/scheduler 預設在 `http://127.0.0.1:3000`，Vite UI 在 `http://127.0.0.1:5173` 並代理 `/api`。第一次使用先到「連線與帳戶」刷新 mock 帳戶。

## 設定

完整設定見 [`.env.example`](.env.example)：

- `DATABASE_PATH`：SQLite 路徑，預設 `./data/wealthflow.sqlite`。
- `ADAPTER_MODE`：`mock`、原生整合使用的 `wealthfolio_addon`、fail-closed 的 `wealthfolio`，或舊相容入口 `wealthfolio_bridge`。
- `SCHEDULER_POLL_MS`：到期掃描間隔。
- `EXECUTION_TIMEOUT_MS`：adapter 呼叫逾時；逾時結果為 `UNKNOWN`，不自動重送。
- `LEASE_SECONDS`：worker lease；實際 lease 至少比 timeout 多 5 秒。
- `MATERIALIZE_BATCH_LIMIT`：單一 schedule 每次 tick 最多補記期數，預設 100、上限 1000。
- `WEALTHFLOW_ADDON_TOKEN`：`wealthfolio_addon` 模式使用，至少 24 字元；同一 token 保存在 add-on 的 `ctx.api.secrets`。
- `WEALTHFOLIO_BRIDGE_URL`、`WEALTHFOLIO_BRIDGE_TOKEN`：僅供舊 `wealthfolio_bridge` 相容模式。
- `WEALTHFOLIO_URL`、`WEALTHFOLIO_PASSWORD`：保留給未來直接 adapter；目前直接 adapter 不使用，也不會送到前端。
- `WEALTHFOLIO_USERNAME`、`WEALTHFOLIO_TOKEN`：僅為未來相容保留，可留空。真實 `.env` 不可 commit。

本專案沒有登入與 CSRF 防護，預設只監聽 loopback。若經 reverse proxy 對外提供，需在 proxy 層加入 TLS、身分驗證與來源限制。

## 執行與一致性

Scheduler 以 `BEGIN IMMEDIATE` 交易 materialize execution 並推進 `next_run_at`；`UNIQUE(schedule_id, scheduled_for)` 和穩定 idempotency key 防止相同期數重複。worker 以條件式 UPDATE 取得 lease。明確成功為 `SUCCEEDED`、明確失敗為 `FAILED`、逾時或中斷為 `UNKNOWN`；`UNKNOWN` 只能查核，不能直接重送。

SQLite 使用 WAL、foreign keys 與 busy timeout。Migration 依檔名排序執行並記錄於 `schema_migrations`；不要修改已發布 migration。

## 備份與還原

建議先停止服務再複製 `DATABASE_PATH` 指向的 SQLite 檔案；若不停服務，需同時備份主檔、`-wal` 與 `-shm`，或使用 SQLite 線上備份工具。還原時停止 WealthFlow，放回資料庫檔案後再啟動。請不要直接讀寫 Wealthfolio 的資料庫。

## 故障處理

- `UNKNOWN`：代表逾時或程序中斷，遠端結果不明；只能按「查核結果」，不會自動重送。
- 原生 add-on 模式：瀏覽器關閉時到期紀錄會停在「等待確認」，不是漏跑；重新開啟 Wealthfolio → WealthFlow 後逐筆確認。`UNKNOWN` 只依穩定 activity ID 查核。
- 帳戶找不到：先到「連線與帳戶」刷新帳戶快取。
- 正式 `wealthfolio` 模式：目前會回報不支援，直到有官方外部 API/bridge 契約可驗證。
- 開放區網：不要只改 `HOST=0.0.0.0`；請在反向代理加 TLS、登入與來源限制。

## 文件

- [HTTP API](docs/API.md)
- [原生 add-on 打包與安裝](bridge-addon/README.md)
- [舊 Bridge 相容入口](docs/BRIDGE.md)
- [本次驗證紀錄](docs/VERIFICATION.md)
- [Wealthfolio 相容性](docs/WEALTHFOLIO_COMPATIBILITY.md)
- [systemd 範例](deploy/wealthflow.service)
