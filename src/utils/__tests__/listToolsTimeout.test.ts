import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FIRST_USE_LIST_TOOLS_TIMEOUT_MS,
  LEGACY_LIST_TOOLS_TIMEOUT_ENV_REMOVAL_VERSION,
  STEADY_STATE_LIST_TOOLS_TIMEOUT_MS,
  resetListToolsTimeoutWarningsForTests,
  resolveListToolsTimeoutMs,
} from "../listToolsTimeout.js";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

beforeEach(() => {
  vi.clearAllMocks();
  resetListToolsTimeoutWarningsForTests();
  delete process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT_MS;
  delete process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT;
});

afterEach(() => {
  delete process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT_MS;
  delete process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT;
});

describe("listTools timeout configuration", () => {
  it("keeps separate first-use and steady-state defaults", () => {
    expect(STEADY_STATE_LIST_TOOLS_TIMEOUT_MS).toBe(10_000);
    expect(FIRST_USE_LIST_TOOLS_TIMEOUT_MS).toBe(30_000);
    expect(resolveListToolsTimeoutMs(STEADY_STATE_LIST_TOOLS_TIMEOUT_MS)).toBe(10_000);
    expect(resolveListToolsTimeoutMs(FIRST_USE_LIST_TOOLS_TIMEOUT_MS)).toBe(30_000);
  });

  it("uses _MS when both names are configured and warns once", () => {
    process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT_MS = "9000";
    process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT = "8000";

    expect(resolveListToolsTimeoutMs(STEADY_STATE_LIST_TOOLS_TIMEOUT_MS)).toBe(9_000);
    expect(resolveListToolsTimeoutMs(FIRST_USE_LIST_TOOLS_TIMEOUT_MS)).toBe(9_000);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Both listTools timeout environment variables are set; using SUPER_MCP_LIST_TOOLS_TIMEOUT_MS",
      expect.objectContaining({
        deprecated_env: "SUPER_MCP_LIST_TOOLS_TIMEOUT",
        removal_version: LEGACY_LIST_TOOLS_TIMEOUT_ENV_REMOVAL_VERSION,
      }),
    );
  });

  it("accepts the old name with one process-wide deprecation warning", () => {
    process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT = "7000";

    expect(resolveListToolsTimeoutMs(STEADY_STATE_LIST_TOOLS_TIMEOUT_MS)).toBe(7_000);
    expect(resolveListToolsTimeoutMs(FIRST_USE_LIST_TOOLS_TIMEOUT_MS)).toBe(7_000);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "SUPER_MCP_LIST_TOOLS_TIMEOUT is deprecated; use SUPER_MCP_LIST_TOOLS_TIMEOUT_MS",
      expect.objectContaining({
        removal_version: LEGACY_LIST_TOOLS_TIMEOUT_ENV_REMOVAL_VERSION,
      }),
    );
  });

  it("clamps a process-wide override to each call site's maximum budget", () => {
    process.env.SUPER_MCP_LIST_TOOLS_TIMEOUT_MS = "60000";

    expect(resolveListToolsTimeoutMs(STEADY_STATE_LIST_TOOLS_TIMEOUT_MS)).toBe(10_000);
    expect(resolveListToolsTimeoutMs(FIRST_USE_LIST_TOOLS_TIMEOUT_MS)).toBe(30_000);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Configured listTools timeout exceeds per-call budget; using per-call maximum",
      expect.objectContaining({ configured_ms: 60_000, maximum_ms: 10_000 }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Configured listTools timeout exceeds per-call budget; using per-call maximum",
      expect.objectContaining({ configured_ms: 60_000, maximum_ms: 30_000 }),
    );
  });

  it.each([
    ["0", "SUPER_MCP_LIST_TOOLS_TIMEOUT_MS"],
    ["-1", "SUPER_MCP_LIST_TOOLS_TIMEOUT_MS"],
    ["1.5", "SUPER_MCP_LIST_TOOLS_TIMEOUT_MS"],
    ["not-a-number", "SUPER_MCP_LIST_TOOLS_TIMEOUT_MS"],
    ["0", "SUPER_MCP_LIST_TOOLS_TIMEOUT"],
  ])("rejects non-positive-integer values (%s)", (value, envName) => {
    process.env[envName] = value;

    expect(resolveListToolsTimeoutMs(FIRST_USE_LIST_TOOLS_TIMEOUT_MS)).toBe(30_000);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Invalid listTools timeout environment value; using per-call default",
      expect.objectContaining({ env_name: envName, value, default_ms: 30_000 }),
    );
  });
});
