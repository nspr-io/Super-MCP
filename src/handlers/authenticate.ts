import { PackageRegistry } from "../registry.js";
import { getLogger } from "../logging.js";
import { findAvailablePort } from "../utils/portFinder.js";

const logger = getLogger();

export async function handleAuthenticate(
  input: { package_id: string; wait_for_completion?: boolean },
  registry: PackageRegistry
): Promise<any> {
  const { package_id, wait_for_completion = true } = input;
  
  logger.info("=== AUTHENTICATE START ===", { 
    package_id,
    wait_for_completion,
    timestamp: new Date().toISOString(),
  });
  
  const pkg = registry.getPackage(package_id);
  if (!pkg) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "error",
            error: "Package not found",
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
  
  if (pkg.transport === "stdio") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "success",
            message: "stdio packages don't require authentication",
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
  
  try {
    logger.info("Checking if already authenticated", { package_id });
    const client = await registry.getClient(package_id);
    const health = client.healthCheck ? await client.healthCheck() : "ok";
    logger.info("Client health check", { package_id, health });
    
    if (health === "ok") {
      try {
        logger.info("Testing tool access", { package_id });
        const tools = await client.listTools();
        logger.info("Tools accessible", { package_id, tool_count: tools.length });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "already_authenticated",
                message: "Package is already authenticated and connected",
              }, null, 2),
            },
          ],
          isError: false,
        };
      } catch (error) {
        logger.info("Tool access failed, need to authenticate", { 
          package_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.info("Client not available or errored", { 
      package_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  
  try {
    let callbackServer: any = null;
    let oauthPort = 5173;
    
    if (wait_for_completion) {
      try {
        oauthPort = await findAvailablePort(5173, 10);
        logger.info("Found available OAuth port", { package_id, oauth_port: oauthPort });
      } catch (portError) {
        logger.error("Failed to find available port", { 
          package_id,
          error: portError instanceof Error ? portError.message : String(portError)
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "error",
                message: "Failed to find available port for OAuth callback",
                error: portError instanceof Error ? portError.message : String(portError),
              }, null, 2),
            },
          ],
          isError: false,
        };
      }
      
      const { OAuthCallbackServer } = await import("../auth/callbackServer.js");
      callbackServer = new OAuthCallbackServer(oauthPort);
      
      try {
        await callbackServer.start();
        logger.info("OAuth callback server started", { package_id, oauth_port: oauthPort });
        
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error("Failed to start callback server", { 
          package_id,
          error: error instanceof Error ? error.message : String(error)
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                package_id,
                status: "error",
                message: "Failed to start OAuth callback server",
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
          isError: false,
        };
      }
    }
    
    const clients = (registry as any).clients as Map<string, any>;
    clients.delete(package_id);
    
    logger.info("Creating HTTP client with OAuth enabled", { package_id, oauth_port: oauthPort });
    const { HttpMcpClient } = await import("../clients/httpClient.js");
    const httpClient = new HttpMcpClient(package_id, pkg, { oauthPort });
    
    logger.info("Triggering OAuth connection", { package_id });
    
    const connectPromise = httpClient.connectWithOAuth();
    
    if (wait_for_completion && callbackServer) {
      logger.info("Waiting for OAuth callback", { package_id });
      
      try {
        connectPromise.catch(err => {
          logger.debug("OAuth redirect initiated (expected)", {
            package_id,
            error: err instanceof Error ? err.message : String(err)
          });
        });
        
        const callbackPromise = callbackServer.waitForCallback(60000);
        
        const authCode = await callbackPromise;
        logger.info("OAuth callback received", { package_id, has_code: !!authCode });
        
        logger.info("Exchanging authorization code for tokens", { package_id });
        await httpClient.finishOAuth(authCode);
        
        logger.info("OAuth flow completed, verifying connection", { package_id });
        
        clients.set(package_id, httpClient);
        
        let health: "ok" | "error" | "needs_auth" | "timeout" = "timeout";
        try {
          const healthPromise = httpClient.healthCheck ? httpClient.healthCheck() : Promise.resolve("ok" as const);
          const timeoutPromise = new Promise<"timeout">((resolve) => 
            setTimeout(() => resolve("timeout"), 20000)
          );
          health = await Promise.race([healthPromise, timeoutPromise]);
        } catch (err) {
          logger.warn("Connection verification failed - tokens saved but server rejected request. Try using a tool to confirm.", { 
            package_id, 
            error: err instanceof Error ? err.message : String(err) 
          });
          health = "error";
        }
        
        if (health === "ok") {
          logger.info("Authentication verified successfully", { package_id });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "authenticated",
                  message: "Successfully authenticated and verified. Ready to use.",
                }, null, 2),
              },
            ],
            isError: false,
          };
        } else if (health === "timeout") {
          logger.info("Authentication completed, verification pending (slow server)", { package_id });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "authenticated",
                  message: "Successfully authenticated. The server was slow to respond, so full verification will happen on first tool use. Try using a tool to confirm everything works.",
                }, null, 2),
              },
            ],
            isError: false,
          };
        } else {
          logger.error("Authentication verification failed", { package_id, health });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  package_id,
                  status: "error",
                  message: `Authentication completed but verification failed (${health}). The OAuth tokens were saved, but the server rejected the connection. Try using a tool - if it fails, you may need to re-authenticate.`,
                }, null, 2),
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        logger.error("OAuth failed", {
          package_id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (callbackServer) {
          try {
            await callbackServer.stop();
            logger.info("OAuth callback server stopped", { package_id });
          } catch (err) {
            logger.debug("Error stopping callback server", { 
              package_id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }
    } else {
      connectPromise.catch(err => {
        logger.debug("OAuth connection error (expected)", { 
          package_id,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }
    
    clients.set(package_id, httpClient);
    
    const health = httpClient.healthCheck ? await httpClient.healthCheck() : "needs_auth";
    
    if (health === "ok") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              package_id,
              status: "authenticated",
              message: "Successfully authenticated",
            }, null, 2),
          },
        ],
        isError: false,
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              package_id,
              status: "auth_required",
              message: "Authentication required - check browser for OAuth prompt",
            }, null, 2),
          },
        ],
        isError: false,
      };
    }
  } catch (error) {
    logger.error("Authentication failed", {
      package_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: "error",
            message: "Authentication failed",
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
}
