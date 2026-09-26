import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, type Account, type ActivityKind, type Dashboard, type Execution, type ExecutionStatus, type Schedule, type ScheduleDraft } from "./api";

type Tab = "schedules" | "executions" | "connection";
type ScheduleStatusFilter = "CURRENT" | "ACTIVE" | "PAUSED" | "ARCHIVED" | "ALL";

function todayIn(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const emptyDraft: ScheduleDraft = {
  name: "", frequency: "MONTHLY", interval: 1, timeZone: "Asia/Taipei", startDate: todayIn("Asia/Taipei"), endDate: "",
  localTime: "09:00", weekday: 1, dayOfMonth: 1, monthlyMissingDayPolicy: "LAST_DAY",
  accountId: "", destinationAccountId: "", activityKind: "DEPOSIT", amount: "", currency: "TWD", note: "",
  autoPost: false, requireConfirmation: true, catchUpPolicy: "BACKFILL",
};
const activityLabels: Record<ActivityKind, string> = { DEPOSIT: "存入", TRANSFER: "內部轉帳" };
const executionLabels: Record<ExecutionStatus, string> = {
  WAITING_CONFIRMATION: "待確認", PENDING: "待執行", RUNNING: "執行中", SUCCEEDED: "已完成",
  FAILED: "失敗", SKIPPED: "已跳過", UNKNOWN: "結果不明",
};
const weekdays = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];

function Icon({ name }: { name: "calendar" | "history" | "link" | "plus" | "wallet" | "close" }) {
  const paths: Record<typeof name, ReactNode> = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    wallet: <><path d="M4 6h15a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13"/><path d="M16 12h5M16 12h.01"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function formatTime(value: string | null, timeZone = "Asia/Taipei"): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-TW", { timeZone, month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function formatAmount(value: string, currency: string): string {
  try { return new Intl.NumberFormat("zh-TW", { style: "currency", currency, maximumFractionDigits: 8 }).format(Number(value)); }
  catch { return `${currency} ${value}`; }
}
function ruleText(schedule: Schedule): string {
  const every = schedule.interval === 1 ? "每" : `每 ${schedule.interval} `;
  if (schedule.frequency === "DAILY") return `${every}日 ${schedule.localTime}`;
  if (schedule.frequency === "WEEKLY") return `${every}週的${weekdays[(schedule.weekday ?? 1) - 1]} ${schedule.localTime}`;
  const missing = schedule.dayOfMonth! > 28 ? (schedule.monthlyMissingDayPolicy === "LAST_DAY" ? "，短月取月底" : "，短月跳過") : "";
  return `${every}月 ${schedule.dayOfMonth} 日 ${schedule.localTime}${missing}`;
}

export function App() {
  const [tab, setTab] = useState<Tab>("schedules");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [adapter, setAdapter] = useState<{ mode: "mock" | "wealthfolio" | "wealthfolio_bridge" | "wealthfolio_addon"; supportsAtomicTransfer: boolean } | null>(null);
  const [editing, setEditing] = useState<Schedule | null | undefined>(undefined);
  const [resuming, setResuming] = useState<Schedule | null>(null);
  const [filter, setFilter] = useState<ScheduleStatusFilter>("CURRENT");
  const [executionFilters, setExecutionFilters] = useState<{ date: string; schedule: string; status: ExecutionStatus | "" }>({ date: "", schedule: "", status: "" });
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (filters = executionFilters) => {
    const [scheduleData, executionData, accountData, dashboardData, adapterData] = await Promise.all([
      api.schedules(), api.executions(filters), api.accounts(), api.dashboard(), api.adapter(),
    ]);
    setSchedules(scheduleData); setExecutions(executionData); setAccounts(accountData); setDashboard(dashboardData); setAdapter(adapterData);
  };
  useEffect(() => { void load().catch((error: Error) => setNotice({ kind: "error", text: error.message })); }, []);

  const perform = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setNotice(null);
    try { await work(); await load(); setNotice({ kind: "ok", text: success }); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { setBusy(false); }
  };
  const filteredSchedules = useMemo(() => schedules.filter((item) => filter === "ALL" || (filter === "CURRENT" ? item.status !== "ARCHIVED" : item.status === filter)), [schedules, filter]);
  const waiting = dashboard?.executionCounts.WAITING_CONFIRMATION ?? 0;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Icon name="wallet" /></span><div><strong>WealthFlow</strong><small>定期記帳</small></div></div>
      <nav aria-label="主要導覽">
        <button className={tab === "schedules" ? "active" : ""} onClick={() => setTab("schedules")}><Icon name="calendar" />排程台帳</button>
        <button className={tab === "executions" ? "active" : ""} onClick={() => setTab("executions")}><Icon name="history" />執行紀錄{waiting > 0 && <b>{waiting}</b>}</button>
        <button className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}><Icon name="link" />連線與帳戶</button>
      </nav>
      <div className="sidebar-foot"><span className={`status-dot ${adapter?.mode === "mock" || adapter?.mode === "wealthfolio_bridge" || adapter?.mode === "wealthfolio_addon" ? "mock" : "off"}`} />{adapter?.mode === "mock" ? "Mock 安全模式" : adapter?.mode === "wealthfolio_bridge" ? "舊 Bridge 模式" : adapter?.mode === "wealthfolio_addon" ? "原生 add-on 交付" : "正式介面停用"}<small>多時區日曆</small></div>
    </aside>
    <main>
      <header className="topbar"><div><p>{new Intl.DateTimeFormat("zh-TW", { dateStyle: "full", timeZone: "Asia/Taipei" }).format(new Date())}</p><h1>{tab === "schedules" ? "把每一筆固定往來，準時記下來。" : tab === "executions" ? "每次寫入都有跡可循。" : "先確認目的地，再開始記帳。"}</h1></div>{tab === "schedules" && <button className="primary" onClick={() => setEditing(null)}><Icon name="plus" />新增排程</button>}</header>
      {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}<button onClick={() => setNotice(null)}>關閉</button></div>}
      {tab === "schedules" && <SchedulesView schedules={filteredSchedules} all={schedules} dashboard={dashboard} accounts={accounts} addonDelivery={adapter?.mode === "wealthfolio_addon"} filter={filter} setFilter={setFilter} onEdit={setEditing} onResume={setResuming} busy={busy} action={(id, action) => { void perform(() => api.scheduleAction(id, action), action === "pause" ? "排程已暫停" : "排程已封存").catch(() => undefined); }} runNext={(schedule) => { if (schedule.nextRunAt) void perform(() => api.runNext(schedule.id, schedule.nextRunAt!), adapter?.mode === "wealthfolio_addon" ? "下一期已產生，請到 Wealthfolio add-on 確認" : "下一期已執行").catch(() => undefined); }} />}
      {tab === "executions" && <ExecutionsView executions={executions} schedules={schedules} addonDelivery={adapter?.mode === "wealthfolio_addon"} filters={executionFilters} setFilters={setExecutionFilters} applyFilters={(filters) => perform(() => load(filters), "篩選已套用")} busy={busy} action={(id, action) => { void perform(() => api.executionAction(id, action), action === "confirm" ? "已確認並執行" : action === "skip" ? "已跳過" : action === "retry" ? "已重試" : "查核完成").catch(() => undefined); }} />}
      {tab === "connection" && <ConnectionView accounts={accounts} adapter={adapter} busy={busy} perform={perform} />}
    </main>
    {editing !== undefined && <ScheduleDialog schedule={editing} accounts={accounts} transferEnabled={adapter?.supportsAtomicTransfer ?? false} autoPostEnabled={adapter?.mode !== "wealthfolio_addon"} busy={busy} onClose={() => setEditing(undefined)} onSave={async (draft) => { await perform(() => api.saveSchedule(draft, editing?.id), editing ? "排程已更新" : "排程已建立"); setEditing(undefined); }} />}
    {resuming && <ResumeDialog schedule={resuming} busy={busy} onClose={() => setResuming(null)} onResume={async (catchUpPaused) => { await perform(() => api.resumeSchedule(resuming.id, catchUpPaused), catchUpPaused ? "排程已恢復，將依補記策略處理暫停期間" : "排程已恢復，已略過暫停期間"); setResuming(null); }} />}
  </div>;
}

function SchedulesView({ schedules, all, dashboard, accounts, addonDelivery, filter, setFilter, onEdit, onResume, action, runNext, busy }: {
  schedules: Schedule[]; all: Schedule[]; dashboard: Dashboard | null; accounts: Account[]; addonDelivery: boolean; filter: ScheduleStatusFilter;
  setFilter: (value: ScheduleStatusFilter) => void; onEdit: (schedule: Schedule) => void; onResume: (schedule: Schedule) => void;
  action: (id: string, action: "pause" | "archive") => void; runNext: (schedule: Schedule) => void; busy: boolean;
}) {
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.name ?? id;
  return <>
    <section className="ledger-summary"><div className="summary-main"><span>下一次記帳</span><strong>{dashboard?.nextRun ? formatTime(dashboard.nextRun.at) : "尚未安排"}</strong><p>{dashboard?.nextRun?.name ?? "新增排程後，這裡會顯示最近一筆"}</p></div><div><span>運作中</span><strong>{dashboard?.activeSchedules ?? 0}</strong><p>個排程</p></div><div><span>待人工確認</span><strong>{dashboard?.executionCounts.WAITING_CONFIRMATION ?? 0}</strong><p>筆交易</p></div><div><span>{addonDelivery ? "交付模式" : "本機模式"}</span><strong className="word">{addonDelivery ? "Add-on" : "Mock"}</strong><p>{addonDelivery ? "瀏覽器內確認" : "不接觸正式帳本"}</p></div></section>
    <section className="section-head"><div><h2>排程台帳</h2><p>每個排程依自身時區與起訖日計算</p></div><div className="segmented">{([['CURRENT','目前'],['ACTIVE','運作中'],['PAUSED','已暫停'],['ARCHIVED','已封存'],['ALL','全部']] as const).map(([value,label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div></section>
    <div className="schedule-list">
      {schedules.length === 0 && <div className="empty"><Icon name="calendar" /><h3>這一頁還沒有排程</h3><p>{all.length ? "調整篩選條件查看其他排程。" : "建立第一個固定往來，系統會列出未來五次執行日期。"}</p></div>}
      {schedules.map((schedule) => <article className={`schedule-row ${schedule.status.toLowerCase()}`} key={schedule.id}>
        <div className="date-stamp"><span>{schedule.nextRunAt ? new Intl.DateTimeFormat("zh-TW", { timeZone: schedule.timeZone, month: "short" }).format(new Date(schedule.nextRunAt)) : "—"}</span><strong>{schedule.nextRunAt ? new Intl.DateTimeFormat("zh-TW", { timeZone: schedule.timeZone, day: "2-digit" }).format(new Date(schedule.nextRunAt)) : "—"}</strong></div>
        <div className="schedule-body"><div className="schedule-title"><h3>{schedule.name}</h3><span className={`pill ${schedule.status.toLowerCase()}`}>{schedule.status === "ACTIVE" ? "運作中" : schedule.status === "PAUSED" ? "已暫停" : "已封存"}</span><span className={`pill ${addonDelivery || !schedule.autoPost ? "confirm" : "active"}`}>{addonDelivery ? "add-on 確認" : schedule.autoPost ? "自動入帳" : "需確認"}</span></div><p>{activityLabels[schedule.activityKind]} · {accountName(schedule.accountId)}{schedule.destinationAccountId ? ` → ${accountName(schedule.destinationAccountId)}` : ""} · {schedule.timeZone}</p><details><summary>{ruleText(schedule)}　查看未來五次</summary><ol>{schedule.futureRuns.map((run) => <li key={run}>{formatTime(run, schedule.timeZone)}</li>)}</ol></details></div>
        <div className="amount"><strong>{formatAmount(schedule.amount, schedule.currency)}</strong><span>{schedule.catchUpPolicy === "BACKFILL" ? "漏期補記" : "漏期略過"}</span></div>
        <div className="row-actions">{schedule.status !== "ARCHIVED" && <button onClick={() => onEdit(schedule)}>編輯</button>}{schedule.status === "ACTIVE" && <><button disabled={busy || !schedule.nextRunAt} onClick={() => runNext(schedule)}>立即執行下一期</button><button disabled={busy} onClick={() => action(schedule.id, "pause")}>暫停</button></>}{schedule.status === "PAUSED" && <button disabled={busy} onClick={() => onResume(schedule)}>恢復</button>}{schedule.status !== "ARCHIVED" && <button className="danger-text" disabled={busy} onClick={() => action(schedule.id, "archive")}>封存</button>}</div>
      </article>)}
    </div>
  </>;
}

function ExecutionsView({ executions, schedules, addonDelivery, filters, setFilters, applyFilters, action, busy }: {
  executions: Execution[]; schedules: Schedule[]; addonDelivery: boolean; filters: { date: string; schedule: string; status: ExecutionStatus | "" };
  setFilters: (value: { date: string; schedule: string; status: ExecutionStatus | "" }) => void;
  applyFilters: (filters: { date: string; schedule: string; status: ExecutionStatus | "" }) => Promise<void>;
  action: (id: string, action: "confirm" | "skip" | "retry" | "verify") => void; busy: boolean;
}) {
  return <section className="execution-panel"><div className="section-head"><div><h2>執行紀錄</h2><p>顯示執行當時的排程名稱、金額與幣別快照</p></div></div>
    <form className="filters" onSubmit={(event) => { event.preventDefault(); void applyFilters(filters).catch(() => undefined); }}><label>日期<input type="date" value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} /></label><label>排程<select value={filters.schedule} onChange={(e) => setFilters({ ...filters, schedule: e.target.value })}><option value="">全部</option>{schedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{schedule.name}</option>)}</select></label><label>狀態<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as ExecutionStatus | "" })}><option value="">全部</option>{Object.entries(executionLabels).map(([status,label]) => <option key={status} value={status}>{label}</option>)}</select></label><button disabled={busy}>套用篩選</button><button type="button" onClick={() => { const empty = { date: "", schedule: "", status: "" as const }; setFilters(empty); void applyFilters(empty).catch(() => undefined); }}>清除</button></form>
    {executions.length === 0 ? <div className="empty"><Icon name="history" /><h3>沒有符合條件的執行紀錄</h3><p>調整篩選或等待排程到期。</p></div> : <div className="table-wrap"><table><thead><tr><th>排程</th><th>預定時間</th><th>金額</th><th>狀態</th><th>嘗試</th><th>結果</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
      {executions.map((item) => <tr key={item.id}><td><strong>{item.scheduleName}</strong><small>{item.id.slice(0, 8)}</small></td><td>{formatTime(item.scheduledFor, item.scheduleSnapshot.timeZone)}</td><td><strong>{formatAmount(item.amount, item.currency)}</strong></td><td><span className={`pill ${item.status.toLowerCase()}`}>{executionLabels[item.status]}</span></td><td>{item.attempt}</td><td className="result-cell">{item.adapterReference ?? item.errorMessage ?? "—"}</td><td><div className="table-actions">{item.status === "WAITING_CONFIRMATION" && <>{addonDelivery ? <span>請到 Wealthfolio add-on 確認</span> : <button className="small-primary" disabled={busy} onClick={() => action(item.id, "confirm")}>確認執行</button>}<button disabled={busy} onClick={() => action(item.id, "skip")}>跳過</button></>}{item.status === "FAILED" && <>{!addonDelivery && <button className="small-primary" disabled={busy} onClick={() => action(item.id, "retry")}>重試</button>}<button disabled={busy} onClick={() => action(item.id, "skip")}>跳過</button></>}{item.status === "UNKNOWN" && <>{addonDelivery ? <span>請到 Wealthfolio add-on 查核</span> : <button className="small-primary" disabled={busy} onClick={() => action(item.id, "verify")}>查核結果</button>}</>}</div></td></tr>)}
    </tbody></table></div>}
  </section>;
}

function ConnectionView({ accounts, adapter, busy, perform }: { accounts: Account[]; adapter: { mode: "mock" | "wealthfolio" | "wealthfolio_bridge" | "wealthfolio_addon"; supportsAtomicTransfer: boolean } | null; busy: boolean; perform: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const title = adapter?.mode === "mock" ? "Mock adapter" : adapter?.mode === "wealthfolio_bridge" ? "舊 Bridge adapter" : adapter?.mode === "wealthfolio_addon" ? "Wealthfolio 原生 add-on" : "Wealthfolio 正式 adapter";
  const description = adapter?.mode === "mock" ? "所有活動保存在本機 SQLite，可安全驗證完整流程。" : adapter?.mode === "wealthfolio_bridge" ? "舊相容入口；不代表 add-on 可以長駐或 listen HTTP。" : adapter?.mode === "wealthfolio_addon" ? "Node 在背景產生待交付紀錄；開啟 Wealthfolio add-on 後，由你明確確認並透過 ctx.api 寫入。瀏覽器關閉時不會假裝自動入帳。" : "外部 HTTP 寫入介面尚未由官方契約確認，因此目前安全停用。";
  return <div className="connection-grid"><section className="connection-card"><div className="connection-symbol"><Icon name="link" /></div><h2>{title}</h2><p>{description}</p><dl><div><dt>連線模式</dt><dd>{adapter?.mode ?? "—"}</dd></div><div><dt>原子轉帳</dt><dd>{adapter?.supportsAtomicTransfer ? "可用" : "停用"}</dd></div></dl><button className="primary" disabled={busy} onClick={() => { void perform(api.testAdapter, "連線測試完成").catch(() => undefined); }}>測試連線</button></section><section className="accounts-card"><div className="section-head"><div><h2>帳戶快取</h2><p>排程只會使用已刷新並明確選取的帳戶</p></div><button disabled={busy} onClick={() => { void perform(api.refreshAccounts, "帳戶已刷新").catch(() => undefined); }}>刷新帳戶</button></div><ul>{accounts.length ? accounts.map((account) => <li key={account.id}><span className="account-monogram">{account.name.slice(0, 1)}</span><div><strong>{account.name}</strong><small>{account.id}</small></div><b>{account.currency}</b></li>) : <li className="no-account">尚無帳戶，請先執行刷新。</li>}</ul></section></div>;
}

function ResumeDialog({ schedule, busy, onClose, onResume }: { schedule: Schedule; busy: boolean; onClose: () => void; onResume: (catchUp: boolean) => Promise<void> }) {
  const [catchUp, setCatchUp] = useState(true);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog compact" role="dialog" aria-modal="true" aria-labelledby="resume-title"><header><div><p>{schedule.name}</p><h2 id="resume-title">恢復排程</h2></div><button className="icon-button" onClick={onClose} aria-label="關閉"><Icon name="close" /></button></header><div className="dialog-body"><fieldset><legend>暫停期間怎麼處理？</legend><label className="choice-row"><input type="radio" checked={catchUp} onChange={() => setCatchUp(true)} /><span><strong>依補記策略處理</strong><small>BACKFILL 逐期補記；SKIP 略過已逾期的期數。</small></span></label><label className="choice-row"><input type="radio" checked={!catchUp} onChange={() => setCatchUp(false)} /><span><strong>略過暫停期間</strong><small>直接重新計算現在之後的下一期。</small></span></label></fieldset><footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy} onClick={() => { void onResume(catchUp).catch(() => undefined); }}>恢復排程</button></footer></div></section></div>;
}

function ScheduleDialog({ schedule, accounts, transferEnabled, autoPostEnabled, busy, onClose, onSave }: { schedule: Schedule | null; accounts: Account[]; transferEnabled: boolean; autoPostEnabled: boolean; busy: boolean; onClose: () => void; onSave: (draft: ScheduleDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<ScheduleDraft>(() => schedule ? {
    name: schedule.name, frequency: schedule.frequency, interval: schedule.interval, timeZone: schedule.timeZone,
    startDate: schedule.startDate, endDate: schedule.endDate ?? "", localTime: schedule.localTime,
    weekday: schedule.weekday ?? 1, dayOfMonth: schedule.dayOfMonth ?? 1, monthlyMissingDayPolicy: schedule.monthlyMissingDayPolicy,
    accountId: schedule.accountId, destinationAccountId: schedule.destinationAccountId ?? "", activityKind: schedule.activityKind,
    amount: schedule.amount, currency: schedule.currency, note: schedule.note ?? "", autoPost: autoPostEnabled ? schedule.autoPost : false,
    requireConfirmation: autoPostEnabled ? schedule.requireConfirmation : true, catchUpPolicy: schedule.catchUpPolicy,
  } : { ...emptyDraft, accountId: accounts[0]?.id ?? "", currency: accounts[0]?.currency ?? "TWD" });
  const [preview, setPreview] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState("");
  const update = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); void onSave(draft).catch(() => undefined); };
  const previewRuns = async () => { setPreviewError(""); try { setPreview((await api.previewSchedule(draft)).futureRuns); } catch (error) { setPreviewError(error instanceof Error ? error.message : String(error)); } };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><p>{schedule ? "只調整尚未產生的未來期數" : "建立固定往來"}</p><h2 id="dialog-title">{schedule ? "編輯排程" : "新增排程"}</h2></div><button className="icon-button" onClick={onClose} aria-label="關閉"><Icon name="close" /></button></header>
    <form onSubmit={submit}><div className="form-grid"><label className="wide">排程名稱<input required maxLength={120} value={draft.name} onChange={(e) => update("name", e.target.value)} placeholder="例如：每月定期存款" /></label><label>活動類型<select value={draft.activityKind} onChange={(e) => update("activityKind", e.target.value as ActivityKind)}>{Object.entries(activityLabels).filter(([kind]) => kind !== "TRANSFER" || transferEnabled).map(([kind,label]) => <option key={kind} value={kind}>{label}</option>)}</select>{!transferEnabled && <small>目前 adapter 未確認原子轉帳，已停用轉帳</small>}</label><label>來源帳戶<select required value={draft.accountId} onChange={(e) => { const account = accounts.find((a) => a.id === e.target.value); update("accountId", e.target.value); update("destinationAccountId", ""); if (account) update("currency", account.currency); }}><option value="">選擇帳戶</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label>{draft.activityKind === "TRANSFER" && <label>目的帳戶<select required value={draft.destinationAccountId} onChange={(e) => update("destinationAccountId", e.target.value)}><option value="">選擇相同幣別帳戶</option>{accounts.filter((a) => a.id !== draft.accountId && a.currency === draft.currency).map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label>}<label>金額<input required inputMode="decimal" value={draft.amount} onChange={(e) => update("amount", e.target.value)} placeholder="1000.00" /></label><label>幣別<input required pattern="[A-Za-z]{3}" maxLength={3} value={draft.currency} onChange={(e) => update("currency", e.target.value.toUpperCase())} /></label></div>
    <fieldset><legend>日曆規則</legend><div className="rule-grid"><label>頻率<select value={draft.frequency} onChange={(e) => update("frequency", e.target.value as ScheduleDraft["frequency"])}><option value="DAILY">每日</option><option value="WEEKLY">每週</option><option value="MONTHLY">每月</option></select></label><label>每 N 週期<input type="number" min={1} max={1000} value={draft.interval} onChange={(e) => update("interval", Number(e.target.value))} /></label>{draft.frequency === "WEEKLY" && <label>星期<select value={draft.weekday} onChange={(e) => update("weekday", Number(e.target.value))}>{weekdays.map((day,index) => <option key={day} value={index + 1}>{day}</option>)}</select></label>}{draft.frequency === "MONTHLY" && <><label>日期<input type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(e) => update("dayOfMonth", Number(e.target.value))} /></label><label>短月份<select value={draft.monthlyMissingDayPolicy} onChange={(e) => update("monthlyMissingDayPolicy", e.target.value as ScheduleDraft["monthlyMissingDayPolicy"])}><option value="LAST_DAY">使用月底</option><option value="SKIP">跳過該月</option></select></label></>}<label>當地時間<input required type="time" value={draft.localTime} onChange={(e) => update("localTime", e.target.value)} /></label><label>時區<input required value={draft.timeZone} onChange={(e) => update("timeZone", e.target.value)} list="time-zones" /><datalist id="time-zones"><option value="Asia/Taipei"/><option value="Asia/Tokyo"/><option value="America/New_York"/><option value="Europe/London"/></datalist></label><label>開始日期<input required type="date" value={draft.startDate} onChange={(e) => update("startDate", e.target.value)} /></label><label>結束日期<input type="date" min={draft.startDate} value={draft.endDate} onChange={(e) => update("endDate", e.target.value)} /><small>留白表示不設期限</small></label></div><button type="button" className="preview-button" onClick={() => { void previewRuns(); }}>預覽未來五次</button>{previewError && <p className="field-error">{previewError}</p>}{preview.length > 0 && <ol className="preview-list">{preview.map((run) => <li key={run}>{formatTime(run, draft.timeZone)}</li>)}</ol>}</fieldset>
    <label className="wide">備註<textarea maxLength={500} rows={3} value={draft.note} onChange={(e) => update("note", e.target.value)} placeholder="選填，只記錄必要資訊" /></label><fieldset><legend>執行方式</legend><label className="choice-row"><input type="radio" checked={draft.requireConfirmation} onChange={() => setDraft((value) => ({ ...value, requireConfirmation: true, autoPost: false }))} /><span><strong>到期後等待確認</strong><small>確認後才寫入帳本。</small></span></label><label className="choice-row"><input type="radio" disabled={!autoPostEnabled} checked={draft.autoPost} onChange={() => setDraft((value) => ({ ...value, requireConfirmation: false, autoPost: true }))} /><span><strong>到期自動入帳</strong><small>{autoPostEnabled ? "不等待人工確認，請先確認金額與帳戶。" : "原生 add-on 不是 server worker；瀏覽器關閉後不會執行，故此模式停用。"}</small></span></label><label>停機漏期<select value={draft.catchUpPolicy} onChange={(e) => update("catchUpPolicy", e.target.value as ScheduleDraft["catchUpPolicy"])}><option value="BACKFILL">BACKFILL · 逐期補記</option><option value="SKIP">SKIP · 略過所有逾期期數</option></select></label></fieldset>
    <footer><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy || accounts.length === 0}>{busy ? "儲存中…" : schedule ? "儲存變更" : "建立排程"}</button></footer></form></section></div>;
}
