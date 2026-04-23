/**
 * D20 Stage 2: Real-subprocess integration test for workspace env propagation
 * through an npx-like double-hop subprocess chain.
 *
 * Why this is a distinct test from stdioClient.workspace.integration.test.ts:
 *   - The D17 test covers direct `command: process.execPath, args: [fixture]`
 *     spawning, which exercises one child_process hop.
 *   - Many MCP server configs use `command: 'npx', args: ['-y', '@pkg/name']`,
 *     which is a TWO-hop chain: parent -> npx (Node script) -> server (Node
 *     script). Env propagation needs to survive both hops.
 *   - This test uses a purpose-built `npx-stub.mjs` shim that mimics the
 *     same two-hop structure without requiring a real npm registry.
 *
 * The shim (test/fixtures/npx-stub.mjs) reads NPX_STUB_FIXTURE from its own
 * env to determine which fixture to spawn in hop 2. All other env vars are
 * forwarded to the second-hop child via { env: process.env }.
 *
 * Four tests:
 *   1. Happy path: REBEL_WORKSPACE_PATH -> MCP_WORKSPACE_PATH through both hops
 *   2. Router-over-catalog precedence: parent MCP_WORKSPACE_PATH wins over catalog
 *   3. Rebel-branded pass-through: CUSTOM_MARKER (non-REBEL/MCP env var) is
 *      preserved end-to-end, confirming the shim doesn't filter arbitrary env
 *   4. Workspace-unset safety: no REBEL_ set -> no MCP_WORKSPACE_PATH in child
 *      (prevents a subtle regression where the shim defaults or leaks stale env)
 *
 * Env hygiene:
 *   - NPX_STUB_FIXTURE is set via config.env (NOT by mutating process.env)
 *     so it passes through the standard { env } pipeline and doesn't leak into
 *     test harness state (Amendment b item 5).
 *   - beforeEach/afterEach restore REBEL_/MCP_WORKSPACE_PATH + NPX_STUB_FIXTURE
 *     from originals captured in beforeEach.
 *
 * PID leak sentinel: same pattern as the D17 test — capture transport.pid
 * on connect, probe with kill(pid, 0) in afterEach, fail the test if the
 * child survived close(). Cross-platform (no ps/tasklist).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../src/clients/stdioClient.js';

type EnvSnapshot = {
  version: string;
  mcpWorkspacePath: string | null;
  rebelWorkspacePath: string | null;
  customMarker: string | null;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');
const fixturePath = path.join(fixturesDir, 'workspace-env-mcp-server.mjs');
const npxStubPath = path.join(fixturesDir, 'npx-stub.mjs');

let originalRebelWorkspacePath: string | undefined;
let originalMcpWorkspacePath: string | undefined;
let originalNpxStubFixture: string | undefined;
let lastKnownPid: number | null = null;

function restoreEnv() {
  if (originalRebelWorkspacePath === undefined) {
    delete process.env.REBEL_WORKSPACE_PATH;
  } else {
    process.env.REBEL_WORKSPACE_PATH = originalRebelWorkspacePath;
  }

  if (originalMcpWorkspacePath === undefined) {
    delete process.env.MCP_WORKSPACE_PATH;
  } else {
    process.env.MCP_WORKSPACE_PATH = originalMcpWorkspacePath;
  }

  if (originalNpxStubFixture === undefined) {
    delete process.env.NPX_STUB_FIXTURE;
  } else {
    process.env.NPX_STUB_FIXTURE = originalNpxStubFixture;
  }
}

/**
 * Build an StdioMcpClient configured to spawn the npx-stub shim (hop 1) with
 * env containing NPX_STUB_FIXTURE pointing at the real MCP fixture (hop 2).
 *
 * `env` is passed through config.env (NOT via mutating process.env) so the
 * NPX_STUB_FIXTURE var doesn't leak into other tests or the harness.
 */
function createNpxFixtureClient(env: Record<string, string>) {
  return new StdioMcpClient('workspace-env-npx-fixture', {
    id: 'workspace-env-npx-fixture',
    name: 'Workspace Env npx Fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [npxStubPath, '@example/fake-mcp-package', '--yes'],
    cwd: fixturesDir,
    env: {
      NPX_STUB_FIXTURE: fixturePath,
      ...env,
    },
    visibility: 'default',
  });
}

function captureSubprocessPid(client: StdioMcpClient): number {
  const pid = (client as any).transport?.pid;
  if (typeof pid !== 'number') {
    throw new Error('Failed to capture subprocess PID from StdioMcpClient transport.');
  }
  return pid;
}

function parseSnapshot(result: any): EnvSnapshot {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Expected MCP tool response with content[0].text.');
  }
  return JSON.parse(text) as EnvSnapshot;
}

async function runCleanClose(client: StdioMcpClient) {
  try {
    await client.close();
    // Clean close succeeded. Don't probe the PID (see D17 test rationale for
    // OS-reaper race). lastKnownPid is cleared so afterEach won't alarm.
    lastKnownPid = null;
  } catch (closeError) {
    throw closeError;
  }
}

describe('StdioMcpClient npx double-hop workspace env integration', () => {
  beforeEach(() => {
    originalRebelWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    originalMcpWorkspacePath = process.env.MCP_WORKSPACE_PATH;
    originalNpxStubFixture = process.env.NPX_STUB_FIXTURE;
    lastKnownPid = null;
  });

  afterEach(() => {
    restoreEnv();

    if (lastKnownPid !== null) {
      try {
        process.kill(lastKnownPid, 0);
        process.kill(lastKnownPid, 'SIGKILL');
        throw new Error(
          `Leaked workspace-env npx fixture subprocess detected (pid: ${lastKnownPid}).`,
        );
      } catch (e: any) {
        if (e.code !== 'ESRCH') {
          throw e;
        }
      }
    }
  });

  it(
    'Test 1 — happy path: REBEL_WORKSPACE_PATH -> child MCP_WORKSPACE_PATH through the npx double-hop',
    { timeout: 10_000 },
    async () => {
      process.env.REBEL_WORKSPACE_PATH = '/test-workspace/d20-stage2-happy';
      delete process.env.MCP_WORKSPACE_PATH;

      const client = createNpxFixtureClient({
        CUSTOM_MARKER: 'd20-stage2-marker-value',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        expect(snapshot.version).toBe('d17-fixture-v1');
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d20-stage2-happy');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d20-stage2-marker-value');
      } finally {
        if (lastKnownPid === null) {
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        await runCleanClose(client);
      }
    },
  );

  it(
    "Test 2 — router-over-catalog precedence: parent MCP_WORKSPACE_PATH overrides catalog's through the double-hop",
    { timeout: 10_000 },
    async () => {
      delete process.env.REBEL_WORKSPACE_PATH;
      process.env.MCP_WORKSPACE_PATH = '/test-workspace/d20-stage2-parent-mcp';

      const client = createNpxFixtureClient({
        MCP_WORKSPACE_PATH: '/catalog-value-should-lose',
        CUSTOM_MARKER: 'd20-stage2-router-wins',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        expect(snapshot.version).toBe('d17-fixture-v1');
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d20-stage2-parent-mcp');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d20-stage2-router-wins');
      } finally {
        if (lastKnownPid === null) {
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        await runCleanClose(client);
      }
    },
  );

  it(
    'Test 3 — Rebel-branded pass-through: catalog env vars (non-REBEL/MCP) survive both hops intact',
    { timeout: 10_000 },
    async () => {
      process.env.REBEL_WORKSPACE_PATH = '/test-workspace/d20-stage2-passthrough';
      delete process.env.MCP_WORKSPACE_PATH;

      const client = createNpxFixtureClient({
        CUSTOM_MARKER: 'passthrough-unchanged-through-double-hop',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        // Both REBEL_->MCP_ translation AND pass-through of CUSTOM_MARKER
        // must hold simultaneously. If the shim filters or drops arbitrary
        // env vars, CUSTOM_MARKER will be null here.
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d20-stage2-passthrough');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('passthrough-unchanged-through-double-hop');
      } finally {
        if (lastKnownPid === null) {
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        await runCleanClose(client);
      }
    },
  );

  it(
    'Test 4 — workspace-unset safety: neither REBEL_ nor MCP_ set -> child receives no MCP_WORKSPACE_PATH',
    { timeout: 10_000 },
    async () => {
      delete process.env.REBEL_WORKSPACE_PATH;
      delete process.env.MCP_WORKSPACE_PATH;

      const client = createNpxFixtureClient({
        CUSTOM_MARKER: 'd20-stage2-no-workspace',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        // If the shim (or the router) defaults/fabricates an MCP_WORKSPACE_PATH
        // when none is set, this will FAIL. The test protects against a silent
        // regression where a future refactor adds a fallback that leaks stale
        // workspace state into unconfigured MCPs.
        expect(snapshot.mcpWorkspacePath).toBeNull();
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d20-stage2-no-workspace');
      } finally {
        if (lastKnownPid === null) {
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        await runCleanClose(client);
      }
    },
  );
});
