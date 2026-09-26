# WealthFlow HTTP API

Request/response 使用 JSON。時間戳是 ISO 8601 UTC；`localTime` 與日期規則則在 schedule 的 IANA `timeZone` 中解讀。

## 系統與帳戶

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/adapter`
- `POST /api/adapter/test`
- `GET /api/accounts`
- `POST /api/accounts/refresh`

直接正式 adapter 尚未確認外部寫入契約，因此會 fail closed。`ADAPTER_MODE=wealthfolio_addon` 時，帳戶快取由安裝在 Wealthfolio 的 add-on 同步；`POST /api/accounts/refresh` 只重讀既有快取，不會從 Node 呼叫 `ctx.api`。此模式停用 `TRANSFER` 與 `autoPost`。

## 排程

- `GET /api/schedules`：每筆包含 `futureRuns`（最多五次）。
- `POST /api/schedules/preview`：驗證 payload 並回傳 `{ "futureRuns": [...] }`，不寫入 schedule/execution。
- `POST /api/schedules`
- `PUT /api/schedules/:id`：只改變尚未 materialize 的未來期數。
- `POST /api/schedules/:id/pause`
- `POST /api/schedules/:id/resume`，body 必須是 `{ "catchUpPaused": true|false }`。
- `POST /api/schedules/:id/archive`
- `POST /api/schedules/:id/run-next`，body 必須是 `{ "scheduledFor": "<目前 nextRunAt>" }`。
- `DELETE /api/schedules/:id`：只允許沒有 execution 的已封存排程。

建立、更新與預覽共用 payload：

```json
{
  "name": "每兩月轉入儲蓄",
  "frequency": "MONTHLY",
  "interval": 2,
  "timeZone": "Asia/Taipei",
  "startDate": "2026-10-01",
  "endDate": null,
  "localTime": "09:00",
  "weekday": null,
  "dayOfMonth": 31,
  "monthlyMissingDayPolicy": "LAST_DAY",
  "accountId": "mock-cash-twd",
  "destinationAccountId": "mock-savings-twd",
  "activityKind": "TRANSFER",
  "amount": "5000.00",
  "currency": "TWD",
  "note": "緊急預備金",
  "autoPost": false,
  "requireConfirmation": true,
  "catchUpPolicy": "BACKFILL"
}
```

Validation：

- activity 只接受 `DEPOSIT`、`TRANSFER`。
- `interval` 是 1–1000 的整數；`timeZone` 必須是有效 IANA zone。
- `startDate` 必填；`endDate` 可省略或為 `null`，且不可早於 start；格式皆為 `YYYY-MM-DD`。
- 頻率是 `DAILY`、`WEEKLY`、`MONTHLY`。週排程須給 ISO weekday 1–7；月排程須給 day 1–31。
- `monthlyMissingDayPolicy` 是 `LAST_DAY` 或 `SKIP`。
- 金額須為大於零、最多 18 位小數的十進位字串。
- `autoPost` 與 `requireConfirmation` 必須互補；若兩者都未提供，預設等待確認。
- `catchUpPolicy` 是 `BACKFILL` 或 `SKIP`。

`run-next` 是立即執行「明確指定的下一期」，不是任意日期 API。指定值不等於當下 `nextRunAt` 時會拒絕；已成功的 `(scheduleId, scheduledFor)` 也不會再次入帳。

## 執行紀錄

- `GET /api/executions?limit=100&date=2026-10-31&scheduleId=<id>&status=SUCCEEDED`（亦接受 `schedule` 別名）
- `POST /api/executions/:id/confirm`
- `POST /api/executions/:id/skip`
- `POST /api/executions/:id/retry`：只允許 `FAILED`，沿用 idempotency key。
- `POST /api/executions/:id/verify`：只查核 `UNKNOWN`，不重送。

三個 filter 可單獨或組合使用：`date` 依 execution snapshot 的 schedule time zone 判斷；`schedule` 是 schedule ID；`status` 是 execution status。回應包含 snapshot 的 `scheduleName`、`amount`、`currency`、`activityKind` 與 `scheduleSnapshot`。

狀態：`WAITING_CONFIRMATION`、`PENDING`、`RUNNING`、`SUCCEEDED`、`FAILED`、`SKIPPED`、`UNKNOWN`。

## 原生 add-on 交付 API

以下端點只在 `ADAPTER_MODE=wealthfolio_addon` 開放，全部要求：

```http
Authorization: Bearer <WEALTHFLOW_ADDON_TOKEN>
```

- `GET /api/addon/status`
- `POST /api/addon/accounts/sync`，body：`{ "accounts": [{ "id", "name", "currency" }] }`
- `GET /api/addon/executions`：只列出等待確認、失敗、執行中或 UNKNOWN。
- `POST /api/addon/executions/:id/claim`：從 `WAITING_CONFIRMATION`/`FAILED` 取得有期限的 lease，回傳 `claimToken` 與固定 activity payload。
- `POST /api/addon/executions/:id/complete`：body：`{ "claimToken", "reference" }`，只接受目前 lease owner。
- `POST /api/addon/executions/:id/unknown`：body：`{ "claimToken", "message" }`，保存不確定結果並禁止盲目重送。
- `POST /api/addon/executions/:id/resolve`：body：`{ "reference": "<execution UUID>" }`，只在 add-on 已從 Wealthfolio 查到完全相同的穩定 activity ID 時，將 `UNKNOWN`/`RUNNING` 標記成功。

這些是 WealthFlow 自己的 add-on-to-scheduler contract，不是 Wealthfolio 外部 API。add-on 對它們的請求仍必須走 Wealthfolio 官方 `ctx.api.network.request` HTTPS broker。
