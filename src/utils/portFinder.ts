import * as net from "net";
import { getLogger } from "../logging.js";

const logger = getLogger();

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
 * Check if a specific port is available for binding.
 */
export function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
