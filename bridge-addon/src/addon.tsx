import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AddonContext, AddonEnableFunction, HostAccount, HostActivity } from "./sdk-v3.8.0";
import {
  findStableActivity,
  formatMoney,
  normalizeBaseUrl,
  parseJsonBody,
  toActivityCreate,
  type AddonClaim,
  type QueueExecution,
} from "./core";
import "./styles.css";

declare const __WEALTHFLOW_DEFAULT_ORIGIN__: string;

const BASE_URL_KEY = "wealthflow.base-url";
const TOKEN_SECRET_KEY = "wealthflow-api-token";
let addonContext: AddonContext | undefined;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function StatusMark({ status }: { status: QueueExecution["status"] }) {
  const label = {
    WAITING_CONFIRMATION: "待確認",
    FAILED: "可再次交付",
    RUNNING: "交付中／待查核",
    UNKNOWN: "結果不明",
  }[status];
  return <span className={`wf-status wf-${status.toLowerCase()}`}>{label}</span>;
}

function WealthFlowPage() {
  const ctx = addonContext!;
  const packagedOrigin = __WEALTHFLOW_DEFAULT_ORIGIN__.includes(".invalid") ? "" : __WEALTHFLOW_DEFAULT_ORIGIN__;
  const [baseUrl, setBaseUrl] = useState(packagedOrigin);
  const [token, setToken] = useState("");
  const [accounts, setAccounts] = useState<HostAccount[]>([]);
  const [queue, setQueue] = useState<QueueExecution[]>([]);
  const [recent, setRecent] = useState<HostActivity[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void ctx.api.storage.get(BASE_URL_KEY).then((stored) => {
      if (active && stored) setBaseUrl(stored);
      if (active) setReady(Boolean(stored || packagedOrigin));
    }).catch((cause) => setError(messageOf(cause)));
    return () => { active = false; };
  }, [ctx, packagedOrigin]);

  const request = useCallback(async <T,>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> => {
    const root = normalizeBaseUrl(baseUrl);
    const response = await ctx.api.network.request({
      url: `${root}${path}`,
      method: init?.method ?? "GET",
      auth: { type: "bearer", secretKey: TOKEN_SECRET_KEY },
      ...(init?.body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(init.body),
      }),
    });
    return parseJsonBody<T>(response.status, response.body);
  }, [baseUrl, ctx]);

  const refreshQueue = useCallback(async () => {
    const result = await request<{ executions: QueueExecution[] }>("/api/addon/executions");
    setQueue(result.executions);
  }, [request]);

  const testAndRefresh = useCallback(async () => {
    setBusy("refresh"); setError(""); setNotice("");
    try {
      await request("/api/addon/status");
      const hostAccounts = (await ctx.api.accounts.getAll()).filter((account) => account.isActive && !account.isArchived);
      setAccounts(hostAccounts);
      setSelectedAccount((current) => current || hostAccounts[0]?.id || "");
      await refreshQueue();
      setNotice("Node scheduler 已連線；這個頁面開啟時才能使用 ctx.api。沒有自動背景寫入。 ");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [ctx, refreshQueue, request]);

  useEffect(() => {
    if (ready) void testAndRefresh();
  }, [ready, testAndRefresh]);

  const saveConnection = async () => {
    setBusy("save"); setError(""); setNotice("");
    try {
      const normalized = normalizeBaseUrl(baseUrl);
      await ctx.api.storage.set(BASE_URL_KEY, normalized);
      if (token) {
        if (token.length < 24) throw new Error("Token 至少需要 24 個字元");
        await ctx.api.secrets.set(TOKEN_SECRET_KEY, token);
      }
      setBaseUrl(normalized);
      setToken("");
      setReady(true);
      setNotice("連線設定已保存；token 留在 Wealthfolio 的 add-on secret storage，不會讀回 JavaScript。 ");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const syncAccounts = async () => {
    setBusy("accounts"); setError(""); setNotice("");
    try {
      const hostAccounts = (await ctx.api.accounts.getAll()).filter((account) => account.isActive && !account.isArchived);
      await request("/api/addon/accounts/sync", {
        method: "POST",
        body: { accounts: hostAccounts.map(({ id, name, currency }) => ({ id, name, currency })) },
      });
      setAccounts(hostAccounts);
      setSelectedAccount((current) => current || hostAccounts[0]?.id || "");
      setNotice(`已將 ${hostAccounts.length} 個啟用帳戶同步到 Node scheduler 快取。`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const findByExecution = async (execution: QueueExecution) => {
    const activities = await ctx.api.activities.getAll(execution.scheduleSnapshot.accountId);
    return findStableActivity(activities, execution.id);
  };

  const reconcile = async (execution: QueueExecution) => {
    setBusy(execution.id); setError(""); setNotice("");
    try {
      const existing = await findByExecution(execution);
      if (!existing) {
        setNotice("Wealthfolio 中尚未找到相同穩定 activity ID；狀態維持 UNKNOWN，不會重送。 ");
        return;
      }
      await request(`/api/addon/executions/${encodeURIComponent(execution.id)}/resolve`, {
        method: "POST", body: { reference: existing.id },
      });
      await refreshQueue();
      setNotice("已用 Wealthfolio activity ID 查核成功，執行紀錄標記為成功。 ");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const deliver = async (execution: QueueExecution) => {
    if (execution.activityKind !== "DEPOSIT") {
      setError("v3.8.0 add-on SDK 沒有原子 transfer-pair API，拒絕用兩次 create 交付轉帳。 ");
      return;
    }
    setBusy(execution.id); setError(""); setNotice("");
    let claim: AddonClaim | null = null;
    try {
      claim = await request<AddonClaim>(`/api/addon/executions/${encodeURIComponent(execution.id)}/claim`, { method: "POST" });
      const existing = await findByExecution(execution);
      let reference = existing?.id;
      if (!reference) {
        const created = await ctx.api.activities.create(toActivityCreate(claim));
        if (created.id !== execution.id) {
          throw new Error("Wealthfolio 未保留穩定 activity ID；結果不明，已停止後續交付");
        }
        reference = created.id;
      }
      await request(`/api/addon/executions/${encodeURIComponent(execution.id)}/complete`, {
        method: "POST", body: { claimToken: claim.claimToken, reference },
      });
      await refreshQueue();
      ctx.api.toast.success("已寫入 Wealthfolio");
      setNotice("交付完成；Node ledger 已保存 Wealthfolio activity reference。 ");
    } catch (cause) {
      const detail = messageOf(cause);
      if (claim) {
        try {
          const found = await findByExecution(execution);
          if (found) {
            await request(`/api/addon/executions/${encodeURIComponent(execution.id)}/complete`, {
              method: "POST", body: { claimToken: claim.claimToken, reference: found.id },
            });
            await refreshQueue();
            setNotice("create 回應中斷，但已依穩定 activity ID 查核成功，未重複建立。 ");
            return;
          }
          await request(`/api/addon/executions/${encodeURIComponent(execution.id)}/unknown`, {
            method: "POST", body: { claimToken: claim.claimToken, message: detail },
          });
          await refreshQueue();
        } catch (reportError) {
          ctx.api.logger.error(`Unable to report uncertain delivery: ${messageOf(reportError)}`);
        }
      }
      setError(`${detail}。結果按 UNKNOWN 處理；先查核，不會自動重送。`);
    } finally {
      setBusy(null);
    }
  };

  const loadRecent = async () => {
    if (!selectedAccount) return;
    setBusy("recent"); setError("");
    try {
      const activities = await ctx.api.activities.getAll(selectedAccount);
      setRecent(activities.slice().sort((a, b) => String(b.date ?? b.activityDate).localeCompare(String(a.date ?? a.activityDate))).slice(0, 12));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const counts = useMemo(() => ({
    deliverable: queue.filter((item) => item.status === "WAITING_CONFIRMATION" || item.status === "FAILED").length,
    uncertain: queue.filter((item) => item.status === "UNKNOWN" || item.status === "RUNNING").length,
  }), [queue]);

  return <main className="wf-shell">
    <header className="wf-header">
      <div><h1>WealthFlow</h1><p>長駐排程在 Node，帳本寫入只在你開啟這一頁並確認後發生。</p></div>
      <button className="wf-button wf-button-secondary" disabled={busy !== null || !ready} onClick={() => void testAndRefresh()}>{busy === "refresh" ? "更新中…" : "重新整理"}</button>
    </header>

    <section className="wf-boundary" aria-label="執行邊界">
      <strong>瀏覽器關閉時</strong><span>Node 仍會 materialize 到期紀錄；add-on 與 ctx.api 不會執行，因此不會假裝已自動入帳。</span>
    </section>

    {(error || notice) && <div className={`wf-notice ${error ? "wf-notice-error" : ""}`} role="status">{error || notice}</div>}

    <div className="wf-layout">
      <aside className="wf-side">
        <section className="wf-panel">
          <h2>連線設定</h2>
          <p>套件只可連到安裝時核准的 HTTPS host。</p>
          <label>WealthFlow URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://flow.example.com" /></label>
          <label>Bearer token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="只在更新時輸入" autoComplete="new-password" /></label>
          <button className="wf-button" disabled={busy !== null} onClick={() => void saveConnection()}>保存連線</button>
        </section>

        <section className="wf-panel wf-account-panel">
          <div className="wf-panel-heading"><h2>帳戶</h2><button disabled={busy !== null || !ready} onClick={() => void syncAccounts()}>同步到 scheduler</button></div>
          {accounts.length === 0 ? <p className="wf-empty">尚未從 Wealthfolio 讀到啟用帳戶。</p> : <ul className="wf-account-list">{accounts.map((account) => <li key={account.id}><span>{account.name}</span><b>{account.currency}</b></li>)}</ul>}
        </section>
      </aside>

      <section className="wf-main">
        <div className="wf-metrics">
          <div><span>{counts.deliverable}</span><p>等待你確認</p></div>
          <div><span>{counts.uncertain}</span><p>需要查核</p></div>
          <div><span>{accounts.length}</span><p>可用帳戶</p></div>
        </div>

        <section className="wf-ledger">
          <div className="wf-section-heading"><div><h2>交付佇列</h2><p>一次一筆、取得 lease 後才呼叫 ctx.api。</p></div></div>
          {queue.length === 0 ? <div className="wf-empty wf-empty-large"><strong>目前沒有待處理紀錄</strong><span>Node scheduler 產生到期紀錄後會出現在這裡。</span></div> : <div className="wf-queue">{queue.map((execution) => <article key={execution.id}>
            <div className="wf-queue-time"><time>{dateTime(execution.scheduledFor)}</time><StatusMark status={execution.status} /></div>
            <div className="wf-queue-body"><h3>{execution.scheduleName ?? execution.scheduleId}</h3><p>{execution.activityKind === "DEPOSIT" ? "存入" : "轉帳（不支援）"}至 {accounts.find((account) => account.id === execution.scheduleSnapshot.accountId)?.name ?? execution.scheduleSnapshot.accountId}</p>{execution.errorMessage && <small>{execution.errorMessage}</small>}</div>
            <strong className="wf-amount">{formatMoney(execution.amount, execution.currency)}</strong>
            <div className="wf-actions">{execution.status === "UNKNOWN" || execution.status === "RUNNING"
              ? <button className="wf-button wf-button-secondary" disabled={busy !== null} onClick={() => void reconcile(execution)}>只查核</button>
              : <button className="wf-button" disabled={busy !== null || execution.activityKind !== "DEPOSIT"} onClick={() => void deliver(execution)}>{busy === execution.id ? "處理中…" : "確認寫入"}</button>}</div>
          </article>)}</div>}
        </section>

        <section className="wf-ledger wf-recent">
          <div className="wf-section-heading"><div><h2>Wealthfolio 活動</h2><p>只讀檢視；用於人工比對與 UNKNOWN 查核。</p></div><div className="wf-inline"><select value={selectedAccount} onChange={(event) => setSelectedAccount(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><button className="wf-button wf-button-secondary" disabled={!selectedAccount || busy !== null} onClick={() => void loadRecent()}>載入活動</button></div></div>
          {recent.length === 0 ? <p className="wf-empty">選擇帳戶後載入最近活動。</p> : <div className="wf-activity-list">{recent.map((activity) => <div key={activity.id}><span><b>{activity.activityType}</b><small>{activity.id}</small></span><strong>{activity.amount ? formatMoney(activity.amount, activity.currency) : activity.currency}</strong></div>)}</div>}
        </section>
      </section>
    </div>
  </main>;
}

const WealthFlowRoute = () => <WealthFlowPage />;

const enable: AddonEnableFunction = (ctx) => {
  addonContext = ctx;
  ctx.router.add({ id: "wealthflow", path: "/addons/wealthflow-addon", component: WealthFlowRoute });
  ctx.api.logger.info("WealthFlow add-on loaded in browser sandbox");
  ctx.onDisable(() => {
    addonContext = undefined;
    ctx.api.logger.info("WealthFlow add-on disabled");
  });
};

export default enable;
