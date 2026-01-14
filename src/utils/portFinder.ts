import * as net from "net";
import { getLogger } from "../logging.js";

const logger = getLogger();

/**
 * The host address used for OAuth callback server binding.
 * Using 127.0.0.1 (IPv4 loopback) to:
 * - Avoid Windows Firewall prompts (binding to 0.0.0.0 triggers dialogs)
 * - Ensure consistent behavior across platforms
 * 
 * Note: redirect_uris use "localhost" (see simple.ts), which typically resolves
 * to 127.0.0.1 on most systems. If IPv6 issues arise (localhost -> ::1), we may
 * need to align redirect_uris with this constant.
 * 
 * IMPORTANT: This constant must be used by both:
 * - checkPortAvailable() in this file
 * - OAuthCallbackServer.start() in callbackServer.ts
 */
export const OAUTH_CALLBACK_HOST = "127.0.0.1";

/**
 * Find an available port starting from a given port number.
 * Tries consecutive ports until one is available or max attempts reached.
 */
export async function findAvailablePort(
  startPort: number = 5173,
  maxAttempts: number = 10
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = startPort + attempt;
    const isAvailable = await checkPortAvailable(port);
    if (isAvailable) {
      if (attempt > 0) {
        logger.info("Found available port after retries", {
          requested_port: startPort,
          actual_port: port,
          attempts: attempt + 1,
        });
      }
      return port;
    }
    logger.debug("Port in use, trying next", { port, attempt: attempt + 1 });
  }
  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts - 1}`
  );
}

/**
 * Check if a specific port is available for binding on OAUTH_CALLBACK_HOST.
 * Must match the actual binding used by OAuthCallbackServer.
 */
export function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      logger.debug("Port unavailable", { 
        port, 
        host: OAUTH_CALLBACK_HOST,
        code: err.code,
        message: err.message 
      });
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    // Bind to OAUTH_CALLBACK_HOST to match OAuthCallbackServer behavior
    server.listen(port, OAUTH_CALLBACK_HOST);
  });
}
