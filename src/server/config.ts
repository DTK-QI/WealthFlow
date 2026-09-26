import path from "node:path";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  databasePath: string;
  adapterMode: "mock" | "wealthfolio" | "wealthfolio_bridge" | "wealthfolio_addon";
  wealthfolioBridgeUrl: string | null;
  wealthfolioBridgeToken: string | null;
  wealthflowAddonToken: string | null;
  schedulerPollMs: number;
  executionTimeoutMs: number;
  leaseSeconds: number;
  materializeBatchLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawMode = env.ADAPTER_MODE ?? "mock";
  if (rawMode !== "mock" && rawMode !== "wealthfolio" && rawMode !== "wealthfolio_bridge" && rawMode !== "wealthfolio_addon") {
    throw new Error("ADAPTER_MODE 必須是 mock、wealthfolio、wealthfolio_bridge 或 wealthfolio_addon");
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: positiveInt(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? "info",
    databasePath: path.resolve(env.DATABASE_PATH ?? "./data/wealthflow.sqlite"),
    adapterMode: rawMode,
    wealthfolioBridgeUrl: env.WEALTHFOLIO_BRIDGE_URL?.trim() || null,
    wealthfolioBridgeToken: env.WEALTHFOLIO_BRIDGE_TOKEN?.trim() || null,
    wealthflowAddonToken: env.WEALTHFLOW_ADDON_TOKEN?.trim() || null,
    schedulerPollMs: positiveInt(env.SCHEDULER_POLL_MS, 15_000),
    executionTimeoutMs: positiveInt(env.EXECUTION_TIMEOUT_MS, 10_000),
    leaseSeconds: positiveInt(env.LEASE_SECONDS, 30),
    materializeBatchLimit: Math.min(positiveInt(env.MATERIALIZE_BATCH_LIMIT, 100), 1000),
  };
}
