import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec}.{js,ts}', 'src/**/*.{test,spec}.{js,ts}'],
    // Belt-and-braces isolation guard: D17's real-subprocess integration test
    // (test/stdioClient.workspace.integration.test.ts) mutates process.env.REBEL_WORKSPACE_PATH
    // + MCP_WORKSPACE_PATH. `forks` pool gives us one Node worker per test file so env
    // mutations cannot leak across files. This is Vitest's default today, but explicit
    // pinning protects against a future config flip to `threads` silently degrading isolation.
    // Per docs/plans/260423_d17_real_subprocess_workspace_env_integration_test.md §9 Stage 2.
    pool: 'forks',
  },
});
