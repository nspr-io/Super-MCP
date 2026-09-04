import { getLogger } from "../logging.js";

const logger = getLogger();

export const STEADY_STATE_LIST_TOOLS_TIMEOUT_MS = 10_000;
export const FIRST_USE_LIST_TOOLS_TIMEOUT_MS = 30_000;
export const LEGACY_LIST_TOOLS_TIMEOUT_ENV_REMOVAL_VERSION = "3.0.0";

const PRIMARY_ENV = "SUPER_MCP_LIST_TOOLS_TIMEOUT_MS";
const LEGACY_ENV = "SUPER_MCP_LIST_TOOLS_TIMEOUT";

let warnedAboutLegacy = false;
let warnedAboutBoth = false;
const warnedAboutClampedBudgets = new Set<string>();

function parsePositiveInteger(
  envName: string,
  raw: string,
  perCallDefaultMs: number,
): number {
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;

  logger.warn("Invalid listTools timeout environment value; using per-call default", {
    env_name: envName,
    value: raw,
    default_ms: perCallDefaultMs,
  });
  return perCallDefaultMs;
}

function clampToPerCallBudget(
  envName: string,
  configuredMs: number,
  perCallDefaultMs: number,
): number {
  if (configuredMs <= perCallDefaultMs) return configuredMs;

  const warningKey = `${envName}:${perCallDefaultMs}`;
  if (!warnedAboutClampedBudgets.has(warningKey)) {
    warnedAboutClampedBudgets.add(warningKey);
    logger.warn("Configured listTools timeout exceeds per-call budget; using per-call maximum", {
      env_name: envName,
      configured_ms: configuredMs,
      maximum_ms: perCallDefaultMs,
    });
  }
  return perCallDefaultMs;
}

/**
 * Resolves the one process-wide listTools override within a per-call budget.
 * SUPER_MCP_LIST_TOOLS_TIMEOUT is removed in super-mcp 3.0.0.
 */
export function resolveListToolsTimeoutMs(perCallDefaultMs: number): number {
  const primary = process.env[PRIMARY_ENV];
  const legacy = process.env[LEGACY_ENV];

  if (primary !== undefined) {
    if (legacy !== undefined && !warnedAboutBoth) {
      warnedAboutBoth = true;
      logger.warn(
        "Both listTools timeout environment variables are set; using SUPER_MCP_LIST_TOOLS_TIMEOUT_MS",
        {
          deprecated_env: LEGACY_ENV,
          removal_version: LEGACY_LIST_TOOLS_TIMEOUT_ENV_REMOVAL_VERSION,
        },
      );
    }
    return clampToPerCallBudget(
      PRIMARY_ENV,
      parsePositiveInteger(PRIMARY_ENV, primary, perCallDefaultMs),
      perCallDefaultMs,
    );
  }

  if (legacy !== undefined) {
    if (!warnedAboutLegacy) {
      warnedAboutLegacy = true;
      logger.warn(
        "SUPER_MCP_LIST_TOOLS_TIMEOUT is deprecated; use SUPER_MCP_LIST_TOOLS_TIMEOUT_MS",
        {
          removal_version: LEGACY_LIST_TOOLS_TIMEOUT_ENV_REMOVAL_VERSION,
        },
      );
    }
    return clampToPerCallBudget(
      LEGACY_ENV,
      parsePositiveInteger(LEGACY_ENV, legacy, perCallDefaultMs),
      perCallDefaultMs,
    );
  }

  return perCallDefaultMs;
}

export function resetListToolsTimeoutWarningsForTests(): void {
  warnedAboutLegacy = false;
  warnedAboutBoth = false;
  warnedAboutClampedBudgets.clear();
}
