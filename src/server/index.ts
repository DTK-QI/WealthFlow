import fs from "node:fs";
import { loadEnvFile } from "node:process";
import { createAdapter } from "./adapters/index.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { ExecutionService } from "./executions.js";
import { ScheduleService } from "./schedules.js";

if (fs.existsSync(".env")) loadEnvFile(".env");

const config = loadConfig();
const database = new AppDatabase(config.databasePath);
database.migrate();
const adapter = createAdapter(config, database);
const schedules = new ScheduleService(database);
const executions = new ExecutionService(database, adapter, config);
const app = await buildApp({ config, database, adapter, schedules, executions });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  executions.stop();
  await app.close();
  database.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
executions.start();
app.log.info({ adapter: adapter.mode, timezone: "Asia/Taipei" }, "scheduler started");
