import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpClient, PackageConfig } from "../types.js";
import { getLogger } from "../logging.js";
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
class SimpleOAuthProvider implements OAuthClientProvider {
  private packageId: string;
  private savedTokens?: any;
  private codeVerifierValue?: string;
  private savedClientInfo?: any;
  private tokenStoragePath: string;
  
  constructor(packageId: string) {
    this.packageId = packageId;
    this.tokenStoragePath = path.join(homedir(), ".super-mcp", "oauth-tokens");
  }
  
  async initialize() {
    // Load tokens and client info on initialization
    await this.loadPersistedData();
  }
  
  private async loadPersistedData() {
    try {
      // Load client info
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
      // Load tokens
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
    return "http://localhost:5173/oauth/callback";
  }
  
  get clientMetadata() {
    return {
      name: "super-mcp-router", 
      description: "MCP Router for aggregating multiple MCP servers",
      redirect_uris: ["http://localhost:5173/oauth/callback"]
    };
  }
  
  async clientInformation() {
    // Return saved client information from dynamic registration
    return this.savedClientInfo;
  }
  
  async saveClientInformation(info: any) {
    this.savedClientInfo = info;
    
    // Persist client info to disk
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
    // Return saved tokens if available
    return this.savedTokens;
  }
  
  async saveTokens(tokens: any) {
    this.savedTokens = tokens;
    
    // Persist tokens to disk
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
    
    // Extract client_id from the OAuth URL (for dynamic registration)
    const clientId = authUrl.searchParams.get('client_id');
    if (clientId && !this.savedClientInfo) {
      // Save the client_id from dynamic registration
      this.savedClientInfo = {
        client_id: clientId,
        // Notion uses public clients (no secret)
        client_secret: undefined
      };
      logger.info("Extracted client_id from OAuth URL", {
        package_id: this.packageId,
        client_id: clientId
      });
    }
    
    // Open browser for OAuth
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
  
  // Implement SDK's invalidateCredentials interface
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

/**
 * Simplified HTTP MCP client that leverages SDK built-in capabilities
 * instead of custom transport pooling and OAuth management
 */
export class HttpMcpClient implements McpClient {
  private client: Client;
  private transport?: SSEClientTransport | StreamableHTTPClientTransport;
  private packageId: string;
  private config: PackageConfig;
  private isConnected: boolean = false;
  private useOAuth: boolean = false; // Only enable OAuth when explicitly requested
  private oauthProvider?: SimpleOAuthProvider; // Keep OAuth provider instance

  constructor(packageId: string, config: PackageConfig) {
    this.packageId = packageId;
    this.config = config;
    
    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
  }
  
  private async initializeOAuthIfNeeded(forceOAuth: boolean = false) {
    // Only initialize OAuth provider when OAuth is enabled in config
    if (this.config.oauth && !this.oauthProvider) {
      if (forceOAuth) {
        // Explicitly requested - create and initialize OAuth provider
        this.oauthProvider = new SimpleOAuthProvider(this.packageId);
        await this.oauthProvider.initialize();
        this.useOAuth = true;
        logger.debug("OAuth provider initialized (forced) for Notion server", { package_id: this.packageId });
      } else {
        // Check if we have saved tokens first
        const tempProvider = new SimpleOAuthProvider(this.packageId);
        await tempProvider.initialize();
        const tokens = await tempProvider.tokens();
        
        if (tokens && tokens.access_token) {
          // We have tokens, use OAuth
          this.oauthProvider = tempProvider;
          this.useOAuth = true;
          logger.debug("OAuth provider initialized with existing tokens", { package_id: this.packageId });
        } else {
          // No tokens, don't use OAuth (will fail with auth required)
          logger.debug("No OAuth tokens found, will connect without OAuth", { package_id: this.packageId });
        }
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (!this.config.base_url) {
      throw new Error("Base URL is required for HTTP MCP client");
    }

    // Initialize OAuth provider only if we have existing tokens
    // This prevents auto-triggering OAuth on first connection
    await this.initializeOAuthIfNeeded(false);

    logger.info("Connecting to MCP server", {
      package_id: this.packageId,
      base_url: this.config.base_url,
      using_oauth: this.useOAuth,
    });

    // Create the appropriate transport based on the URL
    this.transport = this.createTransport();

    try {
      // Let the SDK handle everything - including OAuth if needed
      await this.client.connect(this.transport);
      this.isConnected = true;

      logger.info("Successfully connected to MCP server", {
        package_id: this.packageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Handle Client ID mismatch - tokens are invalid
      if (errorMessage.includes("Client ID mismatch")) {
        logger.error("OAuth tokens are invalid (Client ID mismatch)", {
          package_id: this.packageId,
          message: "Clearing invalid tokens and requiring re-authentication",
        });
        
        // Use SDK's invalidateCredentials method
        if (this.oauthProvider) {
          // Clear all credentials (tokens, client info, verifier)
          await this.oauthProvider.invalidateCredentials('all');
          logger.info("Invalidated OAuth credentials using SDK method", { package_id: this.packageId });
        }
        
        const authError = new Error(
          `OAuth tokens are invalid (Client ID mismatch). Tokens have been cleared.\n` +
          `Please run 'authenticate(package_id: "${this.packageId}")' to sign in again.`
        );
        authError.name = "InvalidTokenError";
        throw authError;
      }
      
      // Provide more helpful error messages for common auth issues
      if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
        logger.error("Authentication required for MCP server", {
          package_id: this.packageId,
          message: `Run 'authenticate(package_id: "${this.packageId}")' to connect`,
          oauth_configured: this.config.oauth === true,
          has_saved_tokens: this.useOAuth,
        });
        const authError = new Error(
          `Authentication required. Use 'authenticate(package_id: "${this.packageId}")' to sign in.`
        );
        authError.name = "UnauthorizedError";
        throw authError;
      }
      
      logger.error("Failed to connect to MCP server", {
        package_id: this.packageId,
        error: errorMessage,
      });
      throw error;
    }
  }

  private createTransport(): SSEClientTransport | StreamableHTTPClientTransport {
    const url = new URL(this.config.base_url!);
    const options = this.getTransportOptions();
    
    // Use configured transport type, not URL-based detection
    if (this.config.transportType === "sse") {
      logger.debug("Using HTTP+SSE transport (deprecated)", { package_id: this.packageId });
      return new SSEClientTransport(url, options);
    } else {
      // Default to Streamable HTTP (replaced HTTP+SSE as of MCP spec 2025-03-26)
      // transportType is "http" or undefined
      logger.debug("Using Streamable HTTP transport", { package_id: this.packageId });
      return new StreamableHTTPClientTransport(url, options);
    }
  }

  private getTransportOptions() {
    const options: any = {};
    
    // Pass OAuth provider directly to transport (not via fetch middleware)
    // The transport has built-in OAuth handling
    if (this.oauthProvider) {
      options.authProvider = this.oauthProvider;
      logger.debug("OAuth provider added to transport", { package_id: this.packageId });
    }

    // Add extra headers if specified
    if (this.config.extra_headers) {
      // For transports, headers go in requestInit
      options.requestInit = {
        headers: this.config.extra_headers
      };
    }

    return options;
  }


  async listTools(): Promise<any[]> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    try {
      const response = await this.client.listTools();
      return response.tools || [];
    } catch (error) {
      logger.error("Failed to list tools", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async callTool(name: string, args: any): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    // Get timeout from config or environment variable (default: 5 minutes)
    const timeout = this.config.timeout ||
                    parseInt(process.env.SUPER_MCP_TOOL_TIMEOUT || '300000');

    logger.debug("Calling tool on HTTP MCP", {
      package_id: this.packageId,
      tool_name: name,
      timeout_ms: timeout,
    });

    try {
      const response = await this.client.callTool({
        name,
        arguments: args || {},
      }, undefined, {
        timeout,
        resetTimeoutOnProgress: true, // Reset timeout when progress notifications are received
      });
      return response;
    } catch (error) {
      logger.error("Tool call failed", {
        package_id: this.packageId,
        tool_name: name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
      this.isConnected = false;
    } catch (error) {
      logger.error("Error closing client", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async healthCheck(): Promise<"ok" | "error" | "needs_auth"> {
    if (!this.isConnected) {
      return "needs_auth";
    }

    try {
      await this.listTools();
      return "ok";
    } catch (error) {
      if (error instanceof Error && 
          (error.message.includes("Unauthorized") || error.message.includes("401"))) {
        return "needs_auth";
      }
      return "error";
    }
  }

  async requiresAuth(): Promise<boolean> {
    // Check if OAuth is configured for this server
    return this.config.oauth === true;
  }

  async isAuthenticated(): Promise<boolean> {
    return this.isConnected;
  }

  async connectWithOAuth(): Promise<void> {
    // Force OAuth initialization for explicit authentication
    await this.initializeOAuthIfNeeded(true);
    
    // Enable OAuth and try to connect
    this.useOAuth = true;
    this.isConnected = false; // Force disconnection state
    
    try {
      await this.connect();
      // If we get here, connection succeeded without needing OAuth
      this.isConnected = true;
    } catch (error) {
      // OAuth redirect is expected, not an error
      if (error instanceof Error && 
          (error.message.includes("redirect initiated") || 
           error.message.includes("Unauthorized") ||
           error.message.includes("401"))) {
        logger.debug("OAuth redirect initiated or auth needed (expected)", {
          package_id: this.packageId,
          error: error.message
        });
        // Keep isConnected as false until OAuth completes
      } else {
        // Unexpected error
        logger.error("Unexpected error during OAuth connect", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
    // Keep OAuth enabled for subsequent connections to use the tokens
  }

  async finishOAuth(authCode: string): Promise<void> {
    if (!this.transport) {
      throw new Error("Transport not initialized");
    }

    logger.info("Finishing OAuth with authorization code", { 
      package_id: this.packageId,
      has_code: !!authCode 
    });

    // Call the transport's finishAuth method to exchange code for tokens
    if ('finishAuth' in this.transport && typeof this.transport.finishAuth === 'function') {
      await this.transport.finishAuth(authCode);
      logger.info("OAuth token exchange completed", { package_id: this.packageId });
      
      // After token exchange, we need to create a fresh client and transport
      // The previous transport has already been started and can't be reused
      try {
        // Close the old client if it exists
        try {
          await this.client.close();
        } catch (closeError) {
          // Ignore close errors - client might not be properly connected
          logger.debug("Error closing client (expected)", {
            package_id: this.packageId,
            error: closeError instanceof Error ? closeError.message : String(closeError)
          });
        }
        
        // Create a fresh client instance
        this.client = new Client(
          { name: "super-mcp-router", version: "0.1.0" },
          { capabilities: {} }
        );
        
        // Create a new transport instance (the old one has already been started)
        // The OAuth provider in the transport options will now have the tokens
        this.transport = this.createTransport();
        
        // Now connect with the new authenticated transport
        await this.client.connect(this.transport);
        this.isConnected = true;
        logger.info("Client connected successfully with OAuth tokens", { package_id: this.packageId });
      } catch (error) {
        logger.error("Failed to connect after OAuth", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error)
        });
        this.isConnected = false;
        throw error;
      }
    } else {
      throw new Error("Transport doesn't support OAuth finishAuth");
    }
  }
}