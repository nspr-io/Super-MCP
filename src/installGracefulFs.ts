/**
 * Boot-time graceful-fs install (leaf module).
 *
 * Mirrors the desktop main `src/main/startup/installGracefulFs.ts`. Super-MCP
 * runs as a separate Node child process spawned by the desktop, so it has its
 * own fs surface and needs its own gracefulify call.
 *
 * Kill switch: `REBEL_DISABLE_GRACEFUL_FS=1` disables the patch.
 *
 * Failure handling: stash on `globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__` so
 * any future observability layer can surface it. With
 * `REBEL_DEBUG_BOOTSTRAP=1` the failure also logs to stderr.
 *
 * See `docs/plans/260428_graceful_fs_emfile_fix.md` Stage 1.
 */

import { createRequire } from "node:module";

if (process.env.REBEL_DISABLE_GRACEFUL_FS !== "1") {
  try {
    // CommonJS interop — graceful-fs is a CJS package; ESM `import` would work
    // via default-export interop but createRequire() avoids any tsc/Node ESM
    // resolution surprises.
    const requireFn = createRequire(import.meta.url);
    const gracefulFs = requireFn("graceful-fs") as {
      gracefulify: (fs: typeof import("node:fs")) => void;
    };
    const fs = requireFn("node:fs") as typeof import("node:fs");
    gracefulFs.gracefulify(fs); // idempotent
  } catch (e) {
    const g = globalThis as { __REBEL_BOOTSTRAP_LEAF_ERROR__?: unknown };
    g.__REBEL_BOOTSTRAP_LEAF_ERROR__ = {
      kind: "graceful_fs_leaf_install_failed",
      error: {
        name: (e as Error)?.name,
        message: (e as Error)?.message,
        stack: (e as Error)?.stack,
      },
      at: Date.now(),
    };
    if (process.env.REBEL_DEBUG_BOOTSTRAP === "1") {
      // eslint-disable-next-line no-console
      console.warn("[installGracefulFs] failed:", e);
    }
  }
}
