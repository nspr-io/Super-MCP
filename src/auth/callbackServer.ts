import * as http from "http";
import { getLogger } from "../logging.js";

const logger = getLogger();

export class OAuthCallbackServer {
  private server?: http.Server;
  private port: number;
  private resolveCallback?: (code: string) => void;
  private rejectCallback?: (error: Error) => void;

  constructor(port: number = 5173) {
    this.port = port;
  }

  getPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url || "", `http://localhost:${this.port}`);
        
        if (url.pathname === "/oauth/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          
          if (error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <html><body>
                <h1>Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
              </body></html>
            `);
            
            if (this.rejectCallback) {
              this.rejectCallback(new Error(`OAuth error: ${error}`));
            }
          } else if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <html><body>
                <h1>Authentication Successful!</h1>
                <p>You can close this window and return to Claude.</p>
                <script>window.close();</script>
              </body></html>
            `);
            
            logger.info("OAuth callback received", { code });
            
            if (this.resolveCallback) {
              this.resolveCallback(code);
            }
          } else {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Invalid callback</h1></body></html>");
          }
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      this.server.listen(this.port, () => {
        logger.info("OAuth callback server started", { port: this.port });
        resolve();
      });

      this.server.on("error", (err) => {
        logger.error("Failed to start OAuth callback server", { 
          error: err.message,
          port: this.port 
        });
        reject(err);
      });
    });
  }

  async waitForCallback(timeout: number = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

      const timer = setTimeout(() => {
        reject(new Error("OAuth callback timeout"));
      }, timeout);

      // Clean up on resolution
      const originalResolve = this.resolveCallback;
      this.resolveCallback = (code) => {
        clearTimeout(timer);
        originalResolve(code);
      };
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      // Force close immediately - don't wait for keep-alive connections
      // This prevents 60-75 second delays from browser keep-alive
      this.server.closeAllConnections();
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info("OAuth callback server stopped");
          resolve();
        });
      });
    }
  }
}