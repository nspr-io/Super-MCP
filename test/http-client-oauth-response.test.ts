import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpMcpClient } from '../src/clients/httpClient.js';
import type { PackageConfig } from '../src/types.js';

// vi.hoisted ensures the variable exists before vi.mock runs (vi.mock is hoisted)
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/logging.js', () => ({
  getLogger: () => mockLogger,
}));

/**
 * A Response-like object that is NOT `instanceof globalThis.Response`.
 * Simulates a cross-realm Response (e.g., from undici, bundled Electron
 * Node.js, or a V8 context boundary) that breaks the MCP SDK's
 * `instanceof Response` check in parseErrorResponse.
 */
class ForeignRealmResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly type: ResponseType;
  readonly url: string;
  readonly redirected: boolean;
  readonly bodyUsed: boolean;
  private _bodyText: string;

  constructor(bodyText: string, init: { status: number; statusText?: string; headers?: HeadersInit }) {
    this._bodyText = bodyText;
    this.status = init.status;
    this.statusText = init.statusText ?? '';
    this.ok = init.status >= 200 && init.status < 300;
    this.headers = new Headers(init.headers);
    this.body = null;
    this.type = 'default';
    this.url = '';
    this.redirected = false;
    this.bodyUsed = false;
  }

  async text(): Promise<string> { return this._bodyText; }
  async json(): Promise<unknown> { return JSON.parse(this._bodyText); }
  async arrayBuffer(): Promise<ArrayBuffer> { return new TextEncoder().encode(this._bodyText).buffer; }
  async blob(): Promise<Blob> { return new Blob([this._bodyText]); }
  async formData(): Promise<FormData> { return new FormData(); }
  async bytes(): Promise<Uint8Array> { return new TextEncoder().encode(this._bodyText); }
  clone(): ForeignRealmResponse {
    return new ForeignRealmResponse(this._bodyText, {
      status: this.status, statusText: this.statusText, headers: this.headers
    });
  }
  get [Symbol.toStringTag]() { return 'Response'; }
}

function oauthHttpPackage(id: string): PackageConfig {
  return {
    id,
    name: id,
    transport: 'http',
    base_url: 'https://mcp.example.com/mcp',
    oauth: true,
    visibility: 'default',
  };
}

/** Collect all error messages from the mock logger */
function collectErrorMessages(): string {
  return mockLogger.error.mock.calls
    .map((call: unknown[]) => {
      const msg = String(call[0] ?? '');
      const detail = call[1] && typeof call[1] === 'object' ? JSON.stringify(call[1]) : '';
      return msg + ' ' + detail;
    })
    .join('\n');
}

/**
 * Create a mock fetch that returns ForeignRealmResponse objects.
 * Simulates an OAuth server that returns 401 for the MCP endpoint (triggering
 * auth flow) and 404 for registration endpoints (server has no DCR support).
 */
function createForeignRealmFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? 'GET';

    // Initial MCP endpoint request -> 401 to trigger auth flow
    if (urlStr.includes('mcp.example.com/mcp') && (method === 'GET' || method === 'POST')) {
      return new ForeignRealmResponse('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'WWW-Authenticate': 'Bearer',
          'Content-Type': 'text/plain',
        },
      }) as unknown as Response;
    }

    // OAuth well-known discovery endpoints -> 404
    if (urlStr.includes('.well-known/')) {
      return new ForeignRealmResponse('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }) as unknown as Response;
    }

    // Dynamic client registration -> 404 (server doesn't support DCR)
    if (urlStr.includes('/register')) {
      return new ForeignRealmResponse(
        JSON.stringify({ error: 'invalid_request', error_description: 'Registration not supported' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response;
    }

    // Fallback: 404
    return new ForeignRealmResponse('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * Same mock but returning native Response objects (no cross-realm issue).
 */
function createNativeFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? 'GET';

    if (urlStr.includes('mcp.example.com/mcp') && (method === 'GET' || method === 'POST')) {
      return new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'WWW-Authenticate': 'Bearer',
          'Content-Type': 'text/plain',
        },
      });
    }

    if (urlStr.includes('.well-known/')) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (urlStr.includes('/register')) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', error_description: 'Registration not supported' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }) as unknown as typeof fetch;
}

describe('HttpMcpClient cross-realm Response handling', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('ForeignRealmResponse fails instanceof Response (precondition)', () => {
    const foreign = new ForeignRealmResponse('{"ok":true}', { status: 200 });
    expect(foreign instanceof Response).toBe(false);
    expect(foreign.status).toBe(200);
    expect(foreign.ok).toBe(true);
  });

  it('SDK parseErrorResponse produces [object Response] with foreign-realm Response (confirms bug)', async () => {
    const { parseErrorResponse } = await import(
      '@modelcontextprotocol/sdk/client/auth.js'
    );

    const foreignResponse = new ForeignRealmResponse(
      JSON.stringify({ error: 'invalid_client', error_description: 'Bad client' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );

    const result = await parseErrorResponse(foreignResponse as unknown as Response);
    // Confirms the upstream SDK bug: [object Response] in error message
    expect(result.message).toContain('[object Response]');
  });

  it('should not produce [object Response] errors during OAuth with foreign-realm responses', async () => {
    const config = oauthHttpPackage('test-foreign-realm');
    const client = new HttpMcpClient('test-foreign-realm', config, { oauthPort: 5199 });

    globalThis.fetch = createForeignRealmFetch();

    // connectWithOAuth may throw or catch internally depending on error type.
    // We care that no error message ever contains "[object Response]".
    let thrownError: Error | undefined;
    try {
      await client.connectWithOAuth();
    } catch (e) {
      thrownError = e instanceof Error ? e : new Error(String(e));
    }

    if (thrownError) {
      expect(thrownError.message).not.toContain('[object Response]');
    }

    const errors = collectErrorMessages();
    // Without the fix, error logs contain "[object Response]"
    expect(errors).not.toContain('[object Response]');
  });

  it('native Response objects should work without [object Response] errors', async () => {
    const config = oauthHttpPackage('test-native-response');
    const client = new HttpMcpClient('test-native-response', config, { oauthPort: 5198 });

    globalThis.fetch = createNativeFetch();

    let thrownError: Error | undefined;
    try {
      await client.connectWithOAuth();
    } catch (e) {
      thrownError = e instanceof Error ? e : new Error(String(e));
    }

    if (thrownError) {
      expect(thrownError.message).not.toContain('[object Response]');
    }

    const errors = collectErrorMessages();
    expect(errors).not.toContain('[object Response]');
  });
});
