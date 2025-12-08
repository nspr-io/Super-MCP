import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getLogger } from "../../logging.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { homedir } from "os";

const logger = getLogger();
const execAsync = promisify(exec);

/**
 * Simple OAuth provider that opens browser for authorization
 */
export class SimpleOAuthProvider implements OAuthClientProvider {
  private packageId: string;
  private savedTokens?: any;
  private codeVerifierValue?: string;
  private savedClientInfo?: any;
  private tokenStoragePath: string;
  private oauthPort: number;
  
  constructor(packageId: string, oauthPort: number = 5173) {
    this.packageId = packageId;
    this.oauthPort = oauthPort;
    this.tokenStoragePath = path.join(homedir(), ".super-mcp", "oauth-tokens");
  }
  
  async initialize() {
    await this.loadPersistedData();
  }
  
  private async loadPersistedData() {
    try {
      const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
      const clientData = await fs.readFile(clientPath, "utf8");
      this.savedClientInfo = JSON.parse(clientData);
      logger.debug("Loaded persisted client info", { 
        package_id: this.packageId,
        client_id: this.savedClientInfo?.client_id 
      });
    } catch (error) {
      // No saved client info
    }
    
    try {
      const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
      const tokenData = await fs.readFile(tokenPath, "utf8");
      this.savedTokens = JSON.parse(tokenData);
      logger.info("Loaded persisted OAuth tokens", { 
        package_id: this.packageId,
        has_access_token: !!this.savedTokens?.access_token
      });
    } catch (error) {
      // No saved tokens
    }
  }
  
  get redirectUrl(): string {
    return `http://localhost:${this.oauthPort}/oauth/callback`;
  }
  
  get clientMetadata() {
    return {
      name: "super-mcp-router", 
      description: "MCP Router for aggregating multiple MCP servers",
      redirect_uris: [`http://localhost:${this.oauthPort}/oauth/callback`]
    };
  }
  
  async clientInformation() {
    return this.savedClientInfo;
  }
  
  async saveClientInformation(info: any) {
    this.savedClientInfo = info;
    
    try {
      await fs.mkdir(this.tokenStoragePath, { recursive: true });
      const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
      await fs.writeFile(clientPath, JSON.stringify(info, null, 2));
      logger.info("OAuth client information saved to disk", { 
        package_id: this.packageId,
        client_id: info?.client_id,
        path: clientPath
      });
    } catch (error) {
      logger.error("Failed to persist OAuth client info", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  async tokens() {
    return this.savedTokens;
  }
  
  async saveTokens(tokens: any) {
    this.savedTokens = tokens;
    
    try {
      await fs.mkdir(this.tokenStoragePath, { recursive: true });
      const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
      await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
      logger.info("OAuth tokens saved to disk", { 
        package_id: this.packageId,
        path: tokenPath 
      });
    } catch (error) {
      logger.error("Failed to persist OAuth tokens", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  async redirectToAuthorization(authUrl: URL) {
    logger.info("Opening browser for OAuth", { 
      package_id: this.packageId,
      url: authUrl.toString() 
    });
    
    const clientId = authUrl.searchParams.get('client_id');
    if (clientId && !this.savedClientInfo) {
      this.savedClientInfo = {
        client_id: clientId,
        client_secret: undefined
      };
      logger.info("Extracted client_id from OAuth URL", {
        package_id: this.packageId,
        client_id: clientId
      });
    }
    
    const command = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' :
                   'xdg-open';
    
    try {
      await execAsync(`${command} "${authUrl.toString()}"`);
      logger.info("Browser opened for OAuth", { package_id: this.packageId });
    } catch (error) {
      logger.error("Failed to open browser", { 
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  async saveCodeVerifier(verifier: string) {
    this.codeVerifierValue = verifier;
  }
  
  async codeVerifier() {
    return this.codeVerifierValue || "dummy-verifier";
  }
  
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' = 'all') {
    logger.info("Invalidating OAuth credentials", { 
      package_id: this.packageId,
      scope 
    });
    
    if (scope === 'all' || scope === 'tokens') {
      this.savedTokens = undefined;
      try {
        const tokenPath = path.join(this.tokenStoragePath, `${this.packageId}_tokens.json`);
        await fs.unlink(tokenPath).catch(() => {});
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (scope === 'all' || scope === 'client') {
      this.savedClientInfo = undefined;
      try {
        const clientPath = path.join(this.tokenStoragePath, `${this.packageId}_client.json`);
        await fs.unlink(clientPath).catch(() => {});
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (scope === 'all' || scope === 'verifier') {
      this.codeVerifierValue = undefined;
    }
  }
}
