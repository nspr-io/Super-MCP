import * as http from "http";
import { timingSafeEqual } from "crypto";
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
    appName: process.env.SUPER_MCP_APP_NAME || "Rebel",
    iconUrl: process.env.SUPER_MCP_ICON_URL || "",
    iconText: process.env.SUPER_MCP_ICON_TEXT || "✓",
    primaryColor: process.env.SUPER_MCP_PRIMARY_COLOR || "#6366f1",
    countdownSeconds: parseInt(process.env.SUPER_MCP_COUNTDOWN_SECONDS || "5", 10),
    deepLinkUrl: process.env.SUPER_MCP_DEEP_LINK_URL || "rebel://settings/connectors",
  };
}

/** Pick a random item from an array */
function randomPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Format service name for display (capitalize, handle kebab-case) */
function formatServiceName(serviceId: string): string {
  if (!serviceId) return "your service";
  const knownNames: Record<string, string> = {
    "linear": "Linear", "notion": "Notion", "slack": "Slack", "github": "GitHub",
    "google": "Google", "atlassian": "Atlassian", "jira": "Jira", "asana": "Asana",
    "trello": "Trello", "figma": "Figma", "dropbox": "Dropbox", "airtable": "Airtable",
    "monday": "Monday", "clickup": "ClickUp", "todoist": "Todoist", "zendesk": "Zendesk",
    "hubspot": "HubSpot", "salesforce": "Salesforce", "sentry": "Sentry",
    "cloudflare": "Cloudflare", "cloudflare workers": "Cloudflare Workers",
  };
  const lower = serviceId.toLowerCase().split("-")[0]; // Extract base name before instance suffix
  if (knownNames[lower]) return knownNames[lower];
  return serviceId.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Generate a success message with the service name baked in. */
function generateSuccessMessage(serviceName: string): { headline: string; subtitle: string } {
  const messages = [
    { headline: "You're in.", subtitle: `${serviceName} and Rebel are now on speaking terms. The hard part's over.` },
    { headline: "Connected.", subtitle: `${serviceName} has joined the party. Click below to return to Rebel.` },
    { headline: "Done and done.", subtitle: `${serviceName} is locked in. OAuth handshake complete, dignity intact.` },
    { headline: "That's a wrap.", subtitle: `${serviceName} credentials secured. No tokens were harmed in this connection.` },
    { headline: "All systems go.", subtitle: `${serviceName} is officially on board. Click the button to continue.` },
    { headline: "Consider it handled.", subtitle: `${serviceName} and Rebel have exchanged pleasantries and API keys.` },
    { headline: "Mission accomplished.", subtitle: `${serviceName} integration complete. The bureaucracy of OAuth is behind us.` },
    { headline: "Link established.", subtitle: `${serviceName} now answers to Rebel. The paperwork is filed, tokens acquired.` },
    { headline: "Success.", subtitle: `${serviceName} is connected. That was easier than explaining OAuth to a friend.` },
    { headline: "We're in business.", subtitle: `${serviceName} access granted. Click below to return with credentials intact.` },
  ];
  return randomPick(messages);
}

/** Generate success HTML page with prominent button to return to Rebel */
function generateSuccessHtml(serviceId?: string): string {
  const config = getCallbackHtmlConfig();
  const appName = escapeHtml(config.appName);
  const deepLinkUrl = escapeHtml(config.deepLinkUrl);
  const countdownSeconds = config.countdownSeconds;
  const serviceName = formatServiceName(serviceId || "");
  const message = generateSuccessMessage(serviceName);
  const headline = escapeHtml(message.headline);
  const subtitle = escapeHtml(message.subtitle);
  const iconContent = config.iconUrl
    ? `<img src="${escapeHtml(config.iconUrl)}" alt="" style="width:48px;height:48px;">`
    : escapeHtml(config.iconText);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected — ${appName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(145deg, #0c0c14 0%, #1a1a2e 50%, #0f0f1a 100%);
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      color: #e0e0e0;
    }
    .container { max-width: 420px; padding: 56px 48px; text-align: center; }
    .icon {
      width: 88px; height: 88px; margin: 0 auto 28px;
      background: linear-gradient(135deg, ${escapeHtml(config.primaryColor)} 0%, ${escapeHtml(config.primaryColor)}cc 100%);
      border-radius: 22px;
      display: flex; align-items: center; justify-content: center;
      font-size: 44px; color: white;
      box-shadow: 0 12px 40px ${escapeHtml(config.primaryColor)}35;
      animation: iconPulse 2s ease-in-out infinite;
    }
    @keyframes iconPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
    h1 { font-size: 26px; font-weight: 600; margin-bottom: 12px; color: #ffffff; letter-spacing: -0.3px; }
    .subtitle { font-size: 15px; color: #888; line-height: 1.6; margin-bottom: 32px; }
    .countdown-container {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      padding: 16px 24px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .countdown-text { font-size: 14px; color: #666; }
    .countdown-number { font-size: 18px; font-weight: 600; color: ${escapeHtml(config.primaryColor)}; min-width: 24px; }
    .open-button {
      display: inline-block; padding: 14px 28px;
      background: linear-gradient(135deg, ${escapeHtml(config.primaryColor)} 0%, ${escapeHtml(config.primaryColor)}dd 100%);
      color: white; font-size: 15px; font-weight: 500;
      border: none; border-radius: 10px; cursor: pointer;
      text-decoration: none;
      box-shadow: 0 4px 16px ${escapeHtml(config.primaryColor)}40;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .open-button:hover { transform: translateY(-1px); box-shadow: 0 6px 20px ${escapeHtml(config.primaryColor)}50; }
    .fallback { margin-top: 16px; font-size: 13px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${iconContent}</div>
    <h1>${headline}</h1>
    <p class="subtitle">${subtitle}</p>
    <div class="countdown-container">
      <span class="countdown-text">Auto-opening ${appName} in</span>
      <span class="countdown-number" id="countdown">${countdownSeconds}</span>
    </div>
    <a href="${deepLinkUrl}" class="open-button" id="openBtn">Open ${appName}</a>
    <p class="fallback">If ${appName} doesn't open automatically, click the button above.</p>
  </div>
  <script>
    (function() {
      var count = ${countdownSeconds};
      var el = document.getElementById('countdown');
      var btn = document.getElementById('openBtn');
      
      function tick() {
        count--;
        el.textContent = count;
        if (count <= 0) {
          // Try to open via the link - user may need to click manually due to browser security
          window.location.href = '${deepLinkUrl}';
        } else {
          setTimeout(tick, 1000);
        }
      }
      
      setTimeout(tick, 1000);
    })();
  </script>
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
  private expectedState?: string;
  private serviceId?: string;

  constructor(port: number = 5173) {
    this.port = port;
  }
  
  /** Set the service ID for display in the success page (e.g., "Sentry", "Linear") */
  setServiceId(serviceId: string): void {
    this.serviceId = serviceId;
  }
  
  /**
   * Timing-safe string comparison to prevent timing attacks on state validation.
   */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
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
          const receivedState = url.searchParams.get("state");

          if (error) {
            res.writeHead(200, SECURITY_HEADERS);
            res.end(generateErrorHtml(error, errorDescription || undefined));

            if (this.rejectCallback) {
              this.rejectCallback(new Error(`OAuth error: ${error}`));
            }
          } else if (code) {
            // Validate state parameter if expected state is set (CSRF protection)
            if (this.expectedState) {
              if (!receivedState) {
                logger.error("OAuth callback missing state parameter (potential CSRF)", {
                  has_expected_state: true
                });
                res.writeHead(400, SECURITY_HEADERS);
                res.end(generateErrorHtml("invalid_state", "Missing state parameter"));
                
                if (this.rejectCallback) {
                  this.rejectCallback(new Error("OAuth callback missing state parameter (potential CSRF attack)"));
                }
                return;
              }
              
              if (!this.safeCompare(receivedState, this.expectedState)) {
                logger.error("OAuth state mismatch (potential CSRF)", {
                  // Don't log actual state values for security
                  received_length: receivedState.length,
                  expected_length: this.expectedState.length
                });
                res.writeHead(400, SECURITY_HEADERS);
                res.end(generateErrorHtml("invalid_state", "State parameter mismatch"));
                
                if (this.rejectCallback) {
                  this.rejectCallback(new Error("OAuth state mismatch (potential CSRF attack)"));
                }
                return;
              }
              
              logger.debug("OAuth state validated successfully");
            }
            
            res.writeHead(200, SECURITY_HEADERS);
            res.end(generateSuccessHtml(this.serviceId));

            logger.info("OAuth callback received", { has_code: true, state_validated: !!this.expectedState, serviceId: this.serviceId });

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

  /**
   * Wait for the OAuth callback with optional state validation.
   * 
   * @param timeout - Timeout in milliseconds (default 120000)
   * @param expectedState - Expected state parameter for CSRF protection
   */
  async waitForCallback(timeout: number = 120000, expectedState?: string): Promise<string> {
    // Store expected state for validation in the request handler
    this.expectedState = expectedState;
    
    if (expectedState) {
      logger.debug("OAuth callback server waiting with state validation", {
        state_length: expectedState.length
      });
    }
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("OAuth callback timeout"));
      }, timeout);

      // Wrap both resolve and reject to clear the timer
      this.resolveCallback = (code) => {
        clearTimeout(timer);
        resolve(code);
      };
      this.rejectCallback = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      // Wait briefly to allow the success response to be fully sent to the browser
      // before force-closing connections (prevents "Connection Reset" errors)
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Force close to avoid 60-75 second delays from browser keep-alive
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