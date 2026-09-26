import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../database.js";
import type { WealthfolioAdapter } from "../types.js";
import { WealthfolioBridgeAdapter } from "./bridge.js";
import { WealthfolioAddonAdapter } from "./addon.js";
import { MockWealthfolioAdapter } from "./mock.js";
import { OfficialWealthfolioAdapter } from "./wealthfolio.js";

export function createAdapter(config: AppConfig, database: AppDatabase): WealthfolioAdapter {
  if (config.adapterMode === "mock") return new MockWealthfolioAdapter(database);
  if (config.adapterMode === "wealthfolio_bridge") return new WealthfolioBridgeAdapter(config);
  if (config.adapterMode === "wealthfolio_addon") return new WealthfolioAddonAdapter(database, config);
  return new OfficialWealthfolioAdapter();
}
