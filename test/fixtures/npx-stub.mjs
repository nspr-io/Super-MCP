#!/usr/bin/env node
/**
 * D20 Stage 2: npx double-hop shim.
 *
 * Simulates the `npx <package>` code path for integration tests without requiring
 * a real npm registry, package resolution, or network. The shim is invoked by
 * StdioMcpClient as `command: process.execPath, args: [npx-stub.mjs, <pkg>, ...]`
 * (first hop), parses its own CLI args (mimicking npx's --yes / -y / --package
 * / pkg@version conventions), locates the target fixture script, then spawns
 * it via `process.execPath <fixturePath>` (second hop) with env forwarded.
 *
 * This exercises the exact env-propagation pathway that concerns us:
 *   parent process
 *     └── StdioMcpClient.connect() spawns npx-stub via Node
 *           └── npx-stub spawns the MCP server via Node
 *                └── MCP server sees the propagated env vars
 *
 * Since both hops use Node's child_process spawn() with { env } option, the
 * propagation semantics match what real `npx` does on POSIX (where it IS a
 * Node script itself). On Windows, real npx is a .cmd wrapper that invokes
 * Node — the semantics still match at the child_process layer.
 *
 * Contract:
 *   - args[0] is the faux package name (e.g. `@example/fixture-pkg`) — ignored
 *     except for informational purposes.
 *   - env.NPX_STUB_FIXTURE must be set to the absolute path of the MCP fixture
 *     the shim should spawn in hop 2. This mimics how real npx resolves a
 *     package's entry point — we let the test specify it explicitly rather
 *     than wiring fake package resolution.
 *   - All other env vars are forwarded to hop 2 via spawn's default env
 *     inheritance. The test asserts specific vars (REBEL_WORKSPACE_PATH,
 *     MCP_WORKSPACE_PATH, CUSTOM_MARKER, etc.) land in the fixture child.
 *   - stdio: 'inherit' passthrough so MCP stdio transport works transparently.
 *
 * Exit codes: forwards the child's exit code (or 1 on spawn failure).
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const fixturePath = process.env.NPX_STUB_FIXTURE;
if (!fixturePath) {
  process.stderr.write(
    'npx-stub.mjs: NPX_STUB_FIXTURE env var is required (absolute path of MCP fixture).\n',
  );
  process.exit(1);
}

// Skip npx-like CLI flags. Real npx accepts --yes/-y/--package/--call, plus
// positional pkg@version. We ignore them all — the shim only cares about
// finding the fixture via NPX_STUB_FIXTURE.
// (Kept for documentation: the stub IS pretending to be npx, so it should at
// least not crash when the test passes npx-style args.)
const _args = process.argv.slice(2);

const child = spawn(process.execPath, [fixturePath], {
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on('error', (err) => {
  process.stderr.write(`npx-stub.mjs: failed to spawn fixture: ${err.message}\n`);
  process.exit(1);
});
