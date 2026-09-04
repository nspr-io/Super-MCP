import { describe, expect, it, vi } from "vitest";

import { CONNECT_TIMEOUT_MS } from "../../clients/httpClient.js";
import { REGISTRY_CONNECT_ATTEMPTS } from "../../registry.js";
import { FIRST_USE_LIST_TOOLS_TIMEOUT_MS } from "../../utils/listToolsTimeout.js";

vi.mock("../../logging.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Process-boundary mirror of RETRY_PACKAGE_TOOL_TIMEOUT_MS in the app repo's
// src/main/services/mcpService.ts. The desktop-side test pins the same value;
// this side derives the inner duration from Super-MCP's real constants.
const DESKTOP_RETRY_PACKAGE_TOOL_TIMEOUT_MS = 100_000;

describe("restart_package host budget invariant", () => {
  it("keeps the forced reconnect and readiness probe inside the desktop timeout", () => {
    const innerWorstCaseMs =
      REGISTRY_CONNECT_ATTEMPTS * CONNECT_TIMEOUT_MS
      + FIRST_USE_LIST_TOOLS_TIMEOUT_MS;

    expect(innerWorstCaseMs).toBe(90_000);
    expect(DESKTOP_RETRY_PACKAGE_TOOL_TIMEOUT_MS - innerWorstCaseMs).toBe(10_000);
    expect(innerWorstCaseMs).toBeLessThan(DESKTOP_RETRY_PACKAGE_TOOL_TIMEOUT_MS);
  });
});
