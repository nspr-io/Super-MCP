import * as http from "http";
import { getLogger } from "../logging.js";

const logger = getLogger();

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read branding config from environment variables with sensible defaults */
function getCallbackHtmlConfig() {
  return {
    appName: process.env.SUPER_MCP_APP_NAME || "your app",
    iconUrl: process.env.SUPER_MCP_ICON_URL || "",
    iconText: process.env.SUPER_MCP_ICON_TEXT || "✓",
    primaryColor: process.env.SUPER_MCP_PRIMARY_COLOR || "#6366f1",
    autoCloseMs: parseInt(process.env.SUPER_MCP_AUTO_CLOSE_MS || "2000", 10),
  };
}

/** Generate success HTML page */
function generateSuccessHtml(): string {
  const config = getCallbackHtmlConfig();
  const appName = escapeHtml(config.appName);
  const iconContent = config.iconUrl
    ? `<img src="${escapeHtml(config.iconUrl)}" alt="" style="width:40px;height:40px;">`
    : escapeHtml(config.iconText);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e0e0e0;
    }
    .container { max-width: 400px; padding: 48px; text-align: center; }
    .icon {
      width: 80px; height: 80px; margin: 0 auto 24px;
      background: linear-gradient(135deg, ${escapeHtml(config.primaryColor)} 0%, ${escapeHtml(config.primaryColor)}dd 100%);
      border-radius: 20px;
      display: flex; align-items: center; justify-content: center;
      font-size: 40px; color: white;
      box-shadow: 0 8px 32px ${escapeHtml(config.primaryColor)}40;
    }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
    p { font-size: 15px; color: #a0a0a0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${iconContent}</div>
    <h1>Connected</h1>
    <p>You can close this window and return to ${appName}.</p>
  </div>
  <script>setTimeout(function() { window.close(); }, ${config.autoCloseMs});</script>
</body>
</html>`;
}

/** Generate error HTML page */
function generateErrorHtml(error: string, errorDescription?: string): string {
  const config = getCallbackHtmlConfig();
  const appName = escapeHtml(config.appName);
  const errorText = escapeHtml(error);
  const descriptionText = errorDescription ? escapeHtml(errorDescription) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connection Failed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e0e0e0;
    }
    .container { max-width: 400px; padding: 48px; text-align: center; }
    .icon {
      width: 80px; height: 80px; margin: 0 auto 24px;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      border-radius: 20px;
      display: flex; align-items: center; justify-content: center;
      font-size: 40px; color: white;
      box-shadow: 0 8px 32px rgba(239, 68, 68, 0.3);
    }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
    p { font-size: 15px; color: #a0a0a0; line-height: 1.5; margin-bottom: 16px; }
    .error-detail {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px; padding: 12px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px; color: #f87171;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">!</div>
    <h1>Connection Failed</h1>
    <p>Something went wrong. You can close this window and try again in ${appName}.</p>
    <div class="error-detail">${errorText}${descriptionText ? `<br><br>${descriptionText}` : ""}</div>
  </div>
  <script>setTimeout(function() { window.close(); }, 5000);</script>
</body>
</html>`;
}

/** Security headers for OAuth callback responses */
const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

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
          const errorDescription = url.searchParams.get("error_description");

          if (error) {
            res.writeHead(200, SECURITY_HEADERS);
            res.end(generateErrorHtml(error, errorDescription || undefined));

            if (this.rejectCallback) {
              this.rejectCallback(new Error(`OAuth error: ${error}`));
            }
          } else if (code) {
            res.writeHead(200, SECURITY_HEADERS);
            res.end(generateSuccessHtml());

            logger.info("OAuth callback received", { has_code: true });

            if (this.resolveCallback) {
              this.resolveCallback(code);
            }
          } else {
            res.writeHead(400, SECURITY_HEADERS);
            res.end(generateErrorHtml("invalid_callback", "No authorization code received"));
          }
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        logger.info("OAuth callback server started", { port: this.port });
        resolve();
      });

      this.server.on("error", (err) => {
        logger.error("Failed to start OAuth callback server", {
          error: err.message,
          port: this.port,
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