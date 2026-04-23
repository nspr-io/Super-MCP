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
const fixturePath = path.join(__dirname, 'fixtures', 'workspace-env-mcp-server.mjs');

let originalRebelWorkspacePath: string | undefined;
let originalMcpWorkspacePath: string | undefined;
let lastKnownPid: number | null = null;

function restoreWorkspaceEnv() {
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
}

function createFixtureClient(env: Record<string, string>) {
  return new StdioMcpClient('workspace-env-fixture', {
    id: 'workspace-env-fixture',
    name: 'Workspace Env Fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env,
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

describe('StdioMcpClient real-subprocess workspace env integration', () => {
  beforeEach(() => {
    originalRebelWorkspacePath = process.env.REBEL_WORKSPACE_PATH;
    originalMcpWorkspacePath = process.env.MCP_WORKSPACE_PATH;
    lastKnownPid = null;
  });

  afterEach(() => {
    restoreWorkspaceEnv();

    if (lastKnownPid !== null) {
      try {
        process.kill(lastKnownPid, 0);
        process.kill(lastKnownPid, 'SIGKILL');
        throw new Error(`Leaked workspace-env fixture subprocess detected (pid: ${lastKnownPid}).`);
      } catch (e: any) {
        if (e.code !== 'ESRCH') {
          throw e;
        }
      }
    }
  });

  it(
    'happy path — parent REBEL_WORKSPACE_PATH propagates to child as MCP_WORKSPACE_PATH; REBEL_ not leaked; catalog env passes through',
    { timeout: 5000 },
    async () => {
      process.env.REBEL_WORKSPACE_PATH = '/test-workspace/d17-happy';
      delete process.env.MCP_WORKSPACE_PATH;

      const client = createFixtureClient({
        CUSTOM_MARKER: 'd17-marker-value',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        expect(snapshot.version).toBe('d17-fixture-v1');
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d17-happy');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d17-marker-value');
      } finally {
        if (lastKnownPid === null) {
          // Best-effort PID capture if connect() hung/timed out before line above set it.
          // Closes the behavioral-safety gap: a hung connect() would otherwise leave afterEach blind.
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        try {
          await client.close();
          // Clean close succeeded → killProcessTree() + SDK close ran. Trust the contract;
          // don't probe the PID (avoids the OS-reaper race where kill(pid, 0) can report alive
          // for a milliseconds-old zombie). If close() threw, lastKnownPid stays set and afterEach
          // still probes for a genuine leak.
          lastKnownPid = null;
        } catch (closeError) {
          throw closeError;
        }
      }
    },
  );

  it(
    "router-over-catalog precedence — catalog's MCP_WORKSPACE_PATH is overridden by parent-derived value",
    { timeout: 5000 },
    async () => {
      delete process.env.REBEL_WORKSPACE_PATH;
      process.env.MCP_WORKSPACE_PATH = '/test-workspace/d17-parent-mcp';

      const client = createFixtureClient({
        MCP_WORKSPACE_PATH: '/catalog-value-should-lose',
        CUSTOM_MARKER: 'd17-router-wins',
      });

      try {
        await client.connect();
        lastKnownPid = captureSubprocessPid(client);

        const response = await client.callTool('get-env-snapshot', {});
        const snapshot = parseSnapshot(response);

        expect(snapshot.version).toBe('d17-fixture-v1');
        expect(snapshot.mcpWorkspacePath).toBe('/test-workspace/d17-parent-mcp');
        expect(snapshot.rebelWorkspacePath).toBeNull();
        expect(snapshot.customMarker).toBe('d17-router-wins');
      } finally {
        if (lastKnownPid === null) {
          const transportPid = (client as any).transport?.pid;
          if (typeof transportPid === 'number') {
            lastKnownPid = transportPid;
          }
        }
        try {
          await client.close();
          lastKnownPid = null;
        } catch (closeError) {
          throw closeError;
        }
      }
    },
  );
});
