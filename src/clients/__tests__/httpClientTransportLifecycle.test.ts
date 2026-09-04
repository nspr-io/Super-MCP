import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpMcpClient, type HttpMcpClientOptions } from "../httpClient.js";
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
  fetch?: unknown;
  requestInit?: {
    dispatcher?: FakeDispatcherForTest;
  };
}

interface FakeDispatcherForTest {
  options?: { connections: number };
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
  });

  it("isolates transport requests with a per-client dispatcher and degrades observably when undici is unavailable", () => {
    const destroy = vi.fn(async () => {});
    class FakeAgent {
      public readonly destroy = destroy;

      constructor(public readonly options: { connections: number }) {}
    }

    const isolatedClient = makeClient("isolated", {
      loadUndici: () => ({ Agent: FakeAgent }),
    });
    const isolatedOptions = transportOptions(isolatedClient);

    expect(isolatedOptions.requestInit?.dispatcher).toBeInstanceOf(FakeAgent);
    expect(isolatedOptions.requestInit?.dispatcher?.options).toEqual({ connections: 8 });

    const fallbackClient = makeClient("fallback", {
      loadUndici: () => {
        throw new Error("undici unavailable");
      },
    });
    const fallbackOptions = transportOptions(fallbackClient);

    expect(fallbackOptions.requestInit?.dispatcher).toBeUndefined();
    expect(fallbackOptions.fetch).toBeTypeOf("function");
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("dispatcher unavailable"),
      expect.objectContaining({ package_id: "fallback" }),
    );
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

    const makeClosingClient = (id: string) => {
      const destroy = vi.fn(async () => {});
      const client = makeClient(id, {
        loadUndici: () => ({
          Agent: class {
            public readonly destroy = destroy;
          },
        }),
      });
      const transport = new StreamableHTTPClientTransport(
        new URL("https://mcp.example.com/mcp"),
        { sessionId: `${id}-session` },
      );
      const closeSdkClient = vi.fn(async () => {});
      Object.assign(client as unknown as Record<string, unknown>, {
        transport,
        client: { close: closeSdkClient },
      });
      return { client, transport, destroy, closeSdkClient };
    };

    const rejected = makeClosingClient("rejected");
    const rejectedTermination = vi
      .spyOn(rejected.transport, "terminateSession")
      .mockRejectedValue(new Error("DELETE failed"));

    await expect(rejected.client.close()).resolves.toBeUndefined();
    expect(rejectedTermination).toHaveBeenCalledOnce();
    expect(rejected.closeSdkClient).toHaveBeenCalledOnce();
    expect(rejected.destroy).toHaveBeenCalledOnce();

    const hung = makeClosingClient("hung");
    const hungTermination = vi
      .spyOn(hung.transport, "terminateSession")
      .mockReturnValue(new Promise(() => {}));

    const closePromise = hung.client.close();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(closePromise).resolves.toBeUndefined();
    expect(hungTermination).toHaveBeenCalledOnce();
    expect(hung.closeSdkClient).toHaveBeenCalledOnce();
    expect(hung.destroy).toHaveBeenCalledOnce();
  });
});
