# WealthFlow Wealthfolio Add-on

這是可安裝到 Wealthfolio `v3.8.0` 的正式 add-on，不是 HTTP server，也不會宣稱瀏覽器關閉後仍能執行。

它只做官方 runtime 支援的工作：

- 在 browser sandbox 內讀取 `ctx.api.accounts` 與 `ctx.api.activities`。
- 透過 `ctx.api.network.request` 連到安裝時明確核准的 WealthFlow HTTPS host。
- 將帳戶識別碼同步給獨立 Node scheduler。
- 顯示 Node 已 materialize 的待交付紀錄；使用者逐筆確認後，呼叫 `ctx.api.activities.create`。
- 使用 execution UUID 作為 Wealthfolio activity ID；若回應中斷，先用該 ID 查核，結果不明時維持 `UNKNOWN`，不直接重送。

不支援：

- add-on 自己排程或 HTTP listen。
- 瀏覽器關閉後呼叫 `ctx.api`。
- `TRANSFER`。固定版本 SDK 沒有原子 transfer-pair host API，不能用兩次 `create` 冒充原子轉帳。

## 打包

Wealthfolio 的 network allow-list 寫在 manifest，不能安裝後任意放寬。v3.8.0 broker 也會拒絕 localhost、`.local`、LAN/private IP，以及解析到 private IP 的 hostname。請用實際、可由 Wealthfolio server 存取且解析到 public IP 的 HTTPS origin 打包：

```bash
npm run package:addon -- --origin https://flow.example.com
```

產物：`bridge-addon/releases/wealthflow-addon-1.0.0.zip`。打包命令會：

1. 用該 origin 重建 add-on。
2. 把 hostname 寫入套件內 `manifest.network.allowedHosts`。
3. 只封裝 `manifest.json`、`dist/` 與本 README。

原始碼的 `wealthflow.invalid` 是刻意的安全 placeholder；不要直接把未設定實際 host 的套件用於連線。

## 安裝與連線

1. 啟動獨立 WealthFlow Node 服務，設定 `ADAPTER_MODE=wealthfolio_addon` 與至少 24 字元的 `WEALTHFLOW_ADDON_TOKEN`，並在反向代理提供解析到 public IP 的 HTTPS。不要直接暴露未加 TLS/認證限制的 Node port。
2. Wealthfolio → Settings → Addons → Install Addon，選取 ZIP。
3. 審查並核准 `accounts.getAll`、`activities.getAll/create`、`network.request`、`secrets.set/use`，以及打包時的唯一 network host。
4. 開啟側邊欄「WealthFlow」，輸入完整 HTTPS URL 與同一組 token，按「保存連線」。
5. 先「同步到 scheduler」，再到 Node UI 建立僅 `DEPOSIT`、需要確認的排程。
6. 排程到期後回到 add-on，逐筆按「確認寫入」。`UNKNOWN` 只能按「只查核」。

Token 由 `ctx.api.secrets` 保存；add-on 只用 `secretKey` 指示 host broker 加入 Bearer header，不會把既有 token 讀回 JavaScript。
