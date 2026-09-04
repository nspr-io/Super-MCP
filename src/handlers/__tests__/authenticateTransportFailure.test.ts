import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { handleAuthenticate } from "../authenticate.js";
import type { Catalog } from "../../catalog.js";
import { PackageRegistry } from "../../registry.js";

const {
  browserOpen,
  callbackServerInstances,
  httpClientInstances,
  mockLogger,
  postAuthHealth,
  providerInstances,
} = vi.hoisted(() => ({
  browserOpen: vi.fn(),
  callbackServerInstances: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  httpClientInstances: [] as unknown[],
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  postAuthHealth: { current: "ok" as "ok" | "error" | "needs_auth" },
  providerInstances: [] as Array<{
    initialize: ReturnType<typeof vi.fn>;
    invalidateCredentials: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../logging.js", () => ({ getLogger: () => mockLogger }));

vi.mock("../../utils/portFinder.js", () => ({
  checkPortAvailable: vi.fn(async () => true),
  findAvailablePortFromCandidates: vi.fn(async () => 5173),
  getOAuthCallbackPortCandidates: vi.fn(() => [5173]),
  getOAuthCallbackRetryCandidates: vi.fn(() => [5173]),
}));

vi.mock("../../auth/providers/simple.js", () => {
  class MockSimpleOAuthProvider {
    static getSavedClientPort = vi.fn(async () => undefined);
    static hasPersistedAccessToken = vi.fn(async () => true);
    static readNeedsReconnectMarkerState = vi.fn(async () => ({ state: "absent" as const }));

    initialize = vi.fn(async () => {});
    checkAndInvalidateOnPortMismatch = vi.fn(async () => false);
    invalidateCredentials = vi.fn(async () => {});
    setSkipAuthorizeProbe = vi.fn();
    consumeProbeVerdict = vi.fn(() => undefined);
    state = vi.fn(async () => "csrf-state");

    constructor() {
      providerInstances.push(this);
    }
  }

  return { SimpleOAuthProvider: MockSimpleOAuthProvider };
});

vi.mock("../../auth/callbackServer.js", () => {
  class MockOAuthCallbackServer {
    setServiceId = vi.fn();
    start = vi.fn(async () => {});
    waitForCallback = vi.fn(async () => "auth-code");
    stop = vi.fn(async () => {});

    constructor() {
      callbackServerInstances.push(this);
    }
  }

  return { OAuthCallbackServer: MockOAuthCallbackServer };
});

vi.mock("../../clients/httpClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../clients/httpClient.js")>();

  class MockHttpMcpClient {
    connectWithOAuth = vi.fn(() => {
      browserOpen();
      return new Promise<never>(() => {});
    });
    finishOAuth = vi.fn(async () => {});
    healthCheck = vi.fn(async () => postAuthHealth.current);
    close = vi.fn(async () => {});

    constructor() {
      httpClientInstances.push(this);
    }
  }

  return { ...actual, HttpMcpClient: MockHttpMcpClient };
});

const PACKAGE_ID = "transport-failure-test";
const TOKEN_BYTES = Buffer.from(
  '{"access_token":"valid-token-bytes","token_type":"bearer"}\n',
  "utf8",
);

let tokenDir: string;
let tokenPath: string;

function packageConfig() {
  return {
    id: PACKAGE_ID,
    name: PACKAGE_ID,
    transport: "http" as const,
    base_url: "https://mcp.example.test/mcp",
    oauth: true,
    visibility: "default" as const,
  };
}

function createCatalog(): Catalog {
  return {
    clearPackage: vi.fn(),
    getRetryHint: vi.fn(() => ({
      retryAt: 1_800_000,
      retryInMs: 15_000,
      schedule: "transient_backoff",
    })),
  } as unknown as Catalog;
}

function createRegistry(input: {
  client?: {
    healthCheck: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  getClientError?: Error;
}): PackageRegistry {
  const clients = input.client
    ? new Map<string, unknown>([[PACKAGE_ID, input.client]])
    : new Map<string, unknown>();
  const registry = {
    getPackage: vi.fn(() => packageConfig()),
    getClient: input.getClientError
      ? vi.fn().mockRejectedValue(input.getClientError)
      : vi.fn().mockResolvedValue(input.client),
    clients,
    notifyAuthOutcome: vi.fn(),
  } as unknown as PackageRegistry;
  registry.connectForCatalog = vi.fn((packageId, options) =>
    PackageRegistry.prototype.connectForCatalog.call(registry, packageId, options),
  );
  return registry;
}

function parseStatus(result: Awaited<ReturnType<typeof handleAuthenticate>>): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function expectTokenUnchanged(): Promise<void> {
  expect(fs.existsSync(tokenPath)).toBe(true);
  expect(fs.readFileSync(tokenPath)).toEqual(TOKEN_BYTES);
}

function expectNoOAuthStarted(): void {
  expect(providerInstances).toHaveLength(0);
  expect(callbackServerInstances).toHaveLength(0);
  expect(callbackServerInstances.flatMap((server) => server.start.mock.calls)).toHaveLength(0);
  expect(browserOpen).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  providerInstances.length = 0;
  callbackServerInstances.length = 0;
  httpClientInstances.length = 0;
  postAuthHealth.current = "ok";
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "super-mcp-transport-auth-"));
  tokenPath = path.join(tokenDir, `${PACKAGE_ID}_tokens.json`);
  fs.writeFileSync(tokenPath, TOKEN_BYTES);
  process.env.SUPER_MCP_OAUTH_TOKEN_DIR = tokenDir;
});

afterEach(() => {
  delete process.env.SUPER_MCP_OAUTH_TOKEN_DIR;
  fs.rmSync(tokenDir, { recursive: true, force: true });
});

describe("handleAuthenticate transport readiness failures", () => {
  it("returns server_unreachable for a cached-client transport health failure without starting OAuth", async () => {
    const client = {
      healthCheck: vi.fn(async () => "error" as const),
      listTools: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    };
    const registry = createRegistry({ client });

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(parseStatus(result)).toMatchObject({
      status: "server_unreachable",
      last_error_class: "transport_error",
      retry_in_ms: 15_000,
      next_retry_at: 1_800_000,
    });
    expect(client.healthCheck).toHaveBeenCalledWith({ listToolsTimeoutMs: 10_000 });
    await expectTokenUnchanged();
    expectNoOAuthStarted();
  });

  it("returns server_unreachable when post-auth verification reports a transport failure", async () => {
    postAuthHealth.current = "error";
    const registry = createRegistry({
      client: {
        healthCheck: vi.fn(async () => "needs_auth" as const),
        listTools: vi.fn(async () => []),
        close: vi.fn(async () => {}),
      },
    });

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(parseStatus(result)).toMatchObject({
      status: "server_unreachable",
      last_error_class: "transport_error",
      retry_in_ms: 15_000,
      next_retry_at: 1_800_000,
    });
    await expectTokenUnchanged();
    // This failure occurs after the one requested OAuth flow has completed.
    // Exact-one controls prove the test reached that path and did not start a
    // second flow in reaction to its transport-only verification result.
    expect(providerInstances).toHaveLength(1);
    expect(callbackServerInstances).toHaveLength(1);
    expect(callbackServerInstances[0].start).toHaveBeenCalledTimes(1);
    expect(browserOpen).toHaveBeenCalledTimes(1);
    expect((httpClientInstances[0] as { healthCheck: ReturnType<typeof vi.fn> }).healthCheck)
      .toHaveBeenCalledWith({ listToolsTimeoutMs: 30_000 });
  });

  it("returns server_unreachable for a transient getClient rejection without starting OAuth", async () => {
    const connectError = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
    const registry = createRegistry({ getClientError: connectError });

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(parseStatus(result)).toMatchObject({
      status: "server_unreachable",
      last_error_class: "timeout",
    });
    await expectTokenUnchanged();
    expectNoOAuthStarted();
  });

  it("does not issue a redundant direct-list probe after typed readiness succeeds", async () => {
    const client = {
      healthCheck: vi.fn(async () => "ok" as const),
      listTools: vi.fn().mockRejectedValue(new Error("tools/list HTTP 503")),
      close: vi.fn(async () => {}),
    };
    const registry = createRegistry({ client });

    const result = await handleAuthenticate({ package_id: PACKAGE_ID }, registry, createCatalog());

    expect(parseStatus(result)).toMatchObject({ status: "already_authenticated" });
    expect(client.healthCheck).toHaveBeenCalledWith({ listToolsTimeoutMs: 10_000 });
    expect(client.listTools).not.toHaveBeenCalled();
    expect(registry.connectForCatalog).toHaveBeenCalledWith(PACKAGE_ID);
    await expectTokenUnchanged();
    expectNoOAuthStarted();
  });
});
