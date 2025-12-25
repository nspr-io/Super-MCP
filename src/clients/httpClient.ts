import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import PQueue from "p-queue";
import { McpClient, PackageConfig } from "../types.js";
import { getLogger } from "../logging.js";
import { SimpleOAuthProvider, RefreshOnlyOAuthProvider } from "../auth/providers/index.js";

const logger = getLogger();

// HTTP transport can handle more concurrent requests than STDIO, but we still
// limit concurrency to prevent overwhelming upstream servers and to provide
// fair scheduling when multiple agents share the same MCP connection
const HTTP_CONCURRENCY = 5;

export interface HttpMcpClientOptions {
  oauthPort?: number;
}

export class HttpMcpClient implements McpClient {
  private client: Client;
  private transport?: SSEClientTransport | StreamableHTTPClientTransport;
  private packageId: string;
  private config: PackageConfig;
  private isConnected: boolean = false;
  private useOAuth: boolean = false;
  private oauthProvider?: OAuthClientProvider;
  private oauthPort: number;
  private requestQueue: PQueue;

  constructor(packageId: string, config: PackageConfig, options?: HttpMcpClientOptions) {
    this.packageId = packageId;
    this.config = config;
    this.oauthPort = options?.oauthPort ?? 5173;
    
    // Request queue to limit concurrent calls to this HTTP client
    this.requestQueue = new PQueue({ concurrency: HTTP_CONCURRENCY });
    
    logger.info("Created HTTP MCP client with request queue", {
      package_id: packageId,
      queue_concurrency: HTTP_CONCURRENCY,
    });
    
    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
  }
  
  private async initializeOAuthIfNeeded(forceOAuth: boolean = false) {
    if (this.config.oauth && !this.oauthProvider) {
      const simpleProvider = new SimpleOAuthProvider(this.packageId, this.oauthPort);
      await simpleProvider.initialize();
      
      if (forceOAuth) {
        // Part B: Safety net - invalidate stale credentials on port mismatch
        // Only check when forceOAuth=true (explicit authenticate call)
        // Don't check on normal startup to avoid breaking refresh-only flows
        const invalidated = await simpleProvider.checkAndInvalidateOnPortMismatch();
        if (invalidated) {
          logger.info("OAuth credentials invalidated due to port mismatch, will re-register", {
            package_id: this.packageId,
            oauth_port: this.oauthPort
          });
        }
        
        this.oauthProvider = simpleProvider;
        this.useOAuth = true;
        logger.debug("OAuth provider initialized for browser flow", { package_id: this.packageId, oauth_port: this.oauthPort });
      } else {
        const tokens = await simpleProvider.tokens();
        
        if (tokens && tokens.access_token) {
          this.oauthProvider = new RefreshOnlyOAuthProvider(simpleProvider);
          this.useOAuth = true;
          logger.debug("OAuth provider initialized for refresh-only mode (no browser)", { package_id: this.packageId });
        } else {
          logger.debug("No OAuth tokens found, will connect without auth", { package_id: this.packageId });
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

    await this.initializeOAuthIfNeeded(false);

    logger.info("Connecting to MCP server", {
      package_id: this.packageId,
      base_url: this.config.base_url,
      using_oauth: this.useOAuth,
    });

    this.transport = this.createTransport();

    try {
      await this.client.connect(this.transport);
      this.isConnected = true;

      logger.info("Successfully connected to MCP server", {
        package_id: this.packageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes("Client ID mismatch")) {
        logger.error("OAuth tokens are invalid (Client ID mismatch)", {
          package_id: this.packageId,
          message: "Clearing invalid tokens and requiring re-authentication",
        });
        
        if (this.oauthProvider?.invalidateCredentials) {
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
    
    if (this.config.transportType === "sse") {
      logger.debug("Using HTTP+SSE transport (deprecated)", { package_id: this.packageId });
      return new SSEClientTransport(url, options);
    } else {
      logger.debug("Using Streamable HTTP transport", { package_id: this.packageId });
      return new StreamableHTTPClientTransport(url, options);
    }
  }

  private getTransportOptions() {
    const options: any = {};
    
    if (this.oauthProvider) {
      options.authProvider = this.oauthProvider;
      logger.debug("OAuth provider added to transport", { package_id: this.packageId });
    }

    if (this.config.extra_headers) {
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

    logger.info("Listing tools from HTTP MCP", {
      package_id: this.packageId,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
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
    }) as Promise<any[]>;
  }

  async callTool(name: string, args: any): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`Package '${this.packageId}' is not connected`);
    }

    const timeout = this.config.timeout ||
                    parseInt(process.env.SUPER_MCP_TOOL_TIMEOUT || '300000');

    logger.info("Calling tool on HTTP MCP", {
      package_id: this.packageId,
      tool_name: name,
      timeout_ms: timeout,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.callTool({
          name,
          arguments: args || {},
        }, undefined, {
          timeout,
          resetTimeoutOnProgress: true,
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
    });
  }

  async close(): Promise<void> {
    logger.info("Closing HTTP MCP client", {
      package_id: this.packageId,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    try {
      // Clear any pending requests in the queue
      this.requestQueue.clear();
      
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
    return this.config.oauth === true;
  }

  async isAuthenticated(): Promise<boolean> {
    return this.isConnected;
  }

  async connectWithOAuth(): Promise<void> {
    await this.initializeOAuthIfNeeded(true);
    
    this.useOAuth = true;
    this.isConnected = false;
    
    try {
      await this.connect();
      this.isConnected = true;
    } catch (error) {
      if (error instanceof Error && 
          (error.message.includes("redirect initiated") || 
           error.message.includes("Unauthorized") ||
           error.message.includes("401"))) {
        logger.debug("OAuth redirect initiated or auth needed (expected)", {
          package_id: this.packageId,
          error: error.message
        });
      } else {
        logger.error("Unexpected error during OAuth connect", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  }

  async finishOAuth(authCode: string): Promise<void> {
    if (!this.transport) {
      throw new Error("Transport not initialized");
    }

    logger.info("Finishing OAuth with authorization code", { 
      package_id: this.packageId,
      has_code: !!authCode 
    });

    if ('finishAuth' in this.transport && typeof this.transport.finishAuth === 'function') {
      await this.transport.finishAuth(authCode);
      logger.info("OAuth token exchange completed", { package_id: this.packageId });
      
      try {
        try {
          await this.client.close();
        } catch (closeError) {
          logger.debug("Error closing client (expected)", {
            package_id: this.packageId,
            error: closeError instanceof Error ? closeError.message : String(closeError)
          });
        }
        
        this.client = new Client(
          { name: "super-mcp-router", version: "0.1.0" },
          { capabilities: {} }
        );
        
        this.transport = this.createTransport();
        
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
