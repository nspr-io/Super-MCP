import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HttpMcpClient,
  OAUTH_DISCOVERY_TRACE_ERROR_MARKER,
  type HttpMcpClientOptions,
} from "../httpClient.js";
import type { PackageConfig } from "../../types.js";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../logging.js", () => ({
  getLogger: () => mockLogger,
}));

function httpPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: "http",
    base_url: "https://mcp.example.com/mcp",
    visibility: "default",
  } as PackageConfig;
}

function makeClient(id: string, options?: Record<string, unknown>): HttpMcpClient {
  return new HttpMcpClient(id, httpPackage(id), options as HttpMcpClientOptions);
}

interface TransportOptionsForTest {
  fetch?: typeof fetch;
  requestInit?: {
    dispatcher?: FakeDispatcherForTest;
  };
}

interface FakeDispatcherForTest {
  destroy?: () => Promise<void>;
}

function transportOptions(client: HttpMcpClient): TransportOptionsForTest {
  return (
    client as unknown as { getTransportOptions: () => TransportOptionsForTest }
  ).getTransportOptions();
}

describe("HttpMcpClient transport lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps standalone GET streams on a different dispatcher from POST requests even if the SDK spreads requestInit onto GET", async () => {
    const agents: FakeAgent[] = [];
    class FakeAgent {
      public readonly destroy = vi.fn(async () => {});

      constructor() {
        agents.push(this);
      }
    }
    const baseFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", baseFetch);

    const isolatedClient = makeClient("isolated", {
      loadUndici: () => ({ Agent: FakeAgent }),
    });
    const isolatedOptions = transportOptions(isolatedClient);
    const wrappedFetch = isolatedOptions.fetch;
    const requestDispatcher = isolatedOptions.requestInit?.dispatcher;

    expect(agents).toHaveLength(2);
    expect(requestDispatcher).toBe(agents[0]);
    expect(wrappedFetch).toBeTypeOf("function");

    await wrappedFetch!("https://mcp.example.com/mcp", { method: "GET" });
    await wrappedFetch!("https://mcp.example.com/mcp", {
      method: "POST",
      dispatcher: requestDispatcher,
    } as RequestInit);
    await wrappedFetch!("https://mcp.example.com/mcp", {
      method: "GET",
      dispatcher: requestDispatcher,
    } as RequestInit);

    const capturedInit = (index: number): RequestInit & {
      dispatcher?: FakeDispatcherForTest;
    } => {
      const init = baseFetch.mock.calls[index]?.[1];
      if (!init) {
        throw new Error(`fetch call ${index} did not receive an init`);
      }
      return init as RequestInit & { dispatcher?: FakeDispatcherForTest };
    };
    const firstGetInit = capturedInit(0);
    const postInit = capturedInit(1);
    const futureSdkGetInit = capturedInit(2);

    expect(firstGetInit.dispatcher).toBe(agents[1]);
    expect(postInit.dispatcher).toBe(requestDispatcher);
    expect(firstGetInit.dispatcher).not.toBe(postInit.dispatcher);
    expect(futureSdkGetInit.dispatcher).toBe(agents[1]);
    expect(futureSdkGetInit.dispatcher).not.toBe(requestDispatcher);

    const activeSuffix = isolatedClient.getOAuthDiagnosticsSuffix();
    const activePayload = JSON.parse(
      activeSuffix.slice(OAUTH_DISCOVERY_TRACE_ERROR_MARKER.length),
    );
    expect(activePayload.httpDispatcherIsolation).toBe("active");

    await expect(isolatedClient.close()).resolves.toBeUndefined();
    const closedSuffix = isolatedClient.getOAuthDiagnosticsSuffix();
    const closedPayload = JSON.parse(
      closedSuffix.slice(OAUTH_DISCOVERY_TRACE_ERROR_MARKER.length),
    );
    expect(closedPayload.httpDispatcherIsolation).toBe("unavailable");
    expect(agents.every((agent) => agent.destroy?.mock.calls.length === 1)).toBe(true);
  });

  it("warns and records durable diagnostics when dispatcher isolation is unavailable", () => {
    const fallbackClient = makeClient("fallback", {
      loadUndici: () => {
        throw new Error("undici unavailable");
      },
    });
    const fallbackOptions = transportOptions(fallbackClient);

    expect(fallbackOptions.requestInit?.dispatcher).toBeUndefined();
    expect(fallbackOptions.fetch).toBeTypeOf("function");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dispatcher unavailable"),
      expect.objectContaining({ package_id: "fallback" }),
    );

    const suffix = fallbackClient.getOAuthDiagnosticsSuffix();
    const payload = JSON.parse(suffix.slice(OAUTH_DISCOVERY_TRACE_ERROR_MARKER.length));
    expect(payload.httpDispatcherIsolation).toBe("unavailable");
  });

  it("classifies a disconnected client as transport-unready rather than unauthenticated", async () => {
    const client = makeClient("disconnected");

    await expect(client.readinessCheck()).resolves.toMatchObject({
      kind: "transient_failure",
      failureClass: "transport_error",
    });
    await expect(client.healthCheck()).resolves.toBe("error");
  });

  it("passes the per-call first-use budget into the SDK request timeout", async () => {
    const client = makeClient("first-use");
    const listTools = vi.fn(async () => ({ tools: [] }));
    Object.assign(client as unknown as Record<string, unknown>, {
      isConnected: true,
      client: { listTools },
    });

    await expect(client.listTools({ timeoutMs: 30_000 })).resolves.toEqual([]);
    expect(listTools).toHaveBeenCalledWith(undefined, { timeout: 30_000 });
  });

  it("terminates an established HTTP session without letting a rejected or hung DELETE block close", async () => {
    vi.useFakeTimers();

    const makeClosingClient = (id: string, withSession = true) => {
      const destroy = vi.fn(async () => {});
      const callOrder: string[] = [];
      const client = makeClient(id, {
        loadUndici: () => ({
          Agent: class {
            public readonly destroy = destroy;
          },
        }),
      });
      const transport = new StreamableHTTPClientTransport(
        new URL("https://mcp.example.com/mcp"),
        withSession ? { sessionId: `${id}-session` } : undefined,
      );
      const closeSdkClient = vi.fn(async () => {
        callOrder.push("close");
      });
      Object.assign(client as unknown as Record<string, unknown>, {
        transport,
        client: { close: closeSdkClient },
      });
      return { client, transport, destroy, closeSdkClient, callOrder };
    };

    const rejected = makeClosingClient("rejected");
    const rejectedTermination = vi
      .spyOn(rejected.transport, "terminateSession")
      .mockImplementation(async () => {
        rejected.callOrder.push("terminate");
        throw new Error("DELETE failed");
      });

    await expect(rejected.client.close()).resolves.toBeUndefined();
    expect(rejectedTermination).toHaveBeenCalledOnce();
    expect(rejected.closeSdkClient).toHaveBeenCalledOnce();
    expect(rejected.callOrder).toEqual(["terminate", "close"]);
    expect(rejected.destroy).toHaveBeenCalledTimes(2);

    const hung = makeClosingClient("hung");
    const hungTermination = vi
      .spyOn(hung.transport, "terminateSession")
      .mockImplementation(() => {
        hung.callOrder.push("terminate");
        return new Promise(() => {});
      });

    const closePromise = hung.client.close();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(closePromise).resolves.toBeUndefined();
    expect(hungTermination).toHaveBeenCalledOnce();
    expect(hung.closeSdkClient).toHaveBeenCalledOnce();
    expect(hung.callOrder).toEqual(["terminate", "close"]);
    expect(hung.destroy).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("server-side session was left behind"),
      expect.objectContaining({ package_id: "hung", timeout_ms: 2_500 }),
    );

    const noSession = makeClosingClient("no-session", false);
    const noSessionTermination = vi.spyOn(noSession.transport, "terminateSession");

    await expect(noSession.client.close()).resolves.toBeUndefined();
    expect(noSessionTermination).not.toHaveBeenCalled();
    expect(noSession.closeSdkClient).toHaveBeenCalledOnce();
    expect(noSession.callOrder).toEqual(["close"]);
    expect(noSession.destroy).toHaveBeenCalledTimes(2);
  });
});
