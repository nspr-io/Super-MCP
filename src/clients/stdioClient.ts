import { exec } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import PQueue from "p-queue";
import { McpClient, PackageConfig, ReadResourceResult } from "../types.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

// Maximum recursion depth for process tree traversal (prevents runaway in pathological cases)
const MAX_PROCESS_TREE_DEPTH = 20;

/**
 * Kill a process tree to ensure all child/grandchild processes are terminated.
 * This is critical for MCP servers launched via wrappers like `npm run dev` or `npx`,
 * where the actual MCP server is a grandchild process.
 * 
 * On Windows: uses taskkill /t to kill the entire tree (recursive)
 * On Unix/macOS: recursively finds all descendants via pgrep and kills them leaf-first
 * 
 * IMPORTANT: Must be called BEFORE the parent process is killed, otherwise on Unix
 * the children get reparented to PID 1 and we can't find them via PPID.
 */
const killProcessTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    // taskkill /pid <pid> /t /f
    // /t = kill process tree (all child processes) - this IS recursive
    // /f = force kill (don't wait for graceful shutdown)
    return new Promise((resolve) => {
      exec(`taskkill /pid ${pid} /t /f`, (error) => {
        if (error) {
          // Error codes 128 and 1 mean "no process found" which is fine (already dead)
          if ((error as any).code !== 128 && (error as any).code !== 1) {
            logger.debug("taskkill failed (process may already be dead)", { pid, error: error.message });
          }
        }
        resolve();
      });
    });
  } else {
    // On Unix/macOS: recursively find all descendants and kill them leaf-first
    // This ensures children don't get reparented before we can kill them
    const getAllDescendants = (parentPid: number, depth = 0): Promise<number[]> => {
      // Depth limit prevents infinite recursion in pathological cases
      if (depth >= MAX_PROCESS_TREE_DEPTH) {
        logger.warn("Process tree depth limit reached", { parentPid, depth, max: MAX_PROCESS_TREE_DEPTH });
        return Promise.resolve([]);
      }
      
      return new Promise((resolve) => {
        // pgrep -P finds direct children; we recursively gather all descendants
        exec(`pgrep -P ${parentPid} 2>/dev/null`, async (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve([]);
            return;
          }
          const directChildren = stdout.trim().split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p));
          
          // Recursively get grandchildren in parallel (reduces race window for PID reparenting)
          const grandchildrenArrays = await Promise.all(
            directChildren.map(childPid => getAllDescendants(childPid, depth + 1))
          );
          
          // Flatten grandchildren arrays, then append direct children
          // Result order: deepest descendants first, then work up to direct children
          const allDescendants: number[] = [];
          for (const arr of grandchildrenArrays) {
            allDescendants.push(...arr);
          }
          allDescendants.push(...directChildren);
          resolve(allDescendants);
        });
      });
    };
    
    try {
      // Get all descendants (leaves first)
      const descendants = await getAllDescendants(pid);
      
      // Kill all descendants (leaves first, then work up to direct children)
      for (const descendantPid of descendants) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Process may already be dead
        }
      }
      
      // Finally kill the root process
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may already be dead
      }
    } catch {
      // Best effort - if anything fails, still try to kill the root
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore
      }
    }
  }
};

// STDIO transport uses a single stdin/stdout pipe, so requests must be serialized
// to avoid race conditions and "stream busy" errors documented in:
// - https://github.com/modelcontextprotocol/csharp-sdk/issues/88
// - https://github.com/modelcontextprotocol/python-sdk/issues/824
// - https://github.com/jlowin/fastmcp/issues/1625
const STDIO_CONCURRENCY = 1;

export class StdioMcpClient implements McpClient {
  private client: Client;
  private transport: StdioClientTransport;
  private packageId: string;
  private config: PackageConfig;
  private requestQueue: PQueue;

  constructor(packageId: string, config: PackageConfig) {
    this.packageId = packageId;
    this.config = config;
    
    // Request queue to serialize concurrent calls to this STDIO client
    this.requestQueue = new PQueue({ concurrency: STDIO_CONCURRENCY });
    
    logger.info("Created STDIO MCP client with request queue", {
      package_id: packageId,
      queue_concurrency: STDIO_CONCURRENCY,
    });
    
    // We'll initialize the client and transport in connect()
    this.client = new Client(
      { name: "super-mcp-router", version: "0.1.0" },
      { capabilities: {} }
    );
    
    // Placeholder transport - will be replaced in connect()
    // Let the SDK handle environment variable merging with safe defaults
    this.transport = new StdioClientTransport({
      command: config.command || "echo",
      args: config.args || [],
      env: config.env,
      cwd: config.cwd,
    });
  }

  async connect(): Promise<void> {
    logger.info("Connecting to stdio MCP", {
      package_id: this.packageId,
      command: this.config.command,
      args: this.config.args,
    });

    try {
      // Create the transport
      // Let the SDK handle environment variable merging with safe defaults
      this.transport = new StdioClientTransport({
        command: this.config.command || "echo",
        args: this.config.args || [],
        env: this.config.env,
        cwd: this.config.cwd,
      });

      // Connect the client to the transport
      await this.client.connect(this.transport);

      logger.info("Successfully connected to stdio MCP", {
        package_id: this.packageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to connect to stdio MCP", {
        package_id: this.packageId,
        command: this.config.command,
        args: this.config.args,
        error: errorMessage,
      });
      
      // Provide detailed diagnostic information
      let diagnosticMessage = `Failed to connect to MCP server '${this.packageId}'.\n`;
      
      // Check common issues
      if (errorMessage.includes("ENOENT") || errorMessage.includes("not found")) {
        diagnosticMessage += `\n❌ Command not found: '${this.config.command}'`;
        diagnosticMessage += `\nPossible fixes:`;
        diagnosticMessage += `\n  1. Install the MCP server: npm install -g ${this.config.command}`;
        diagnosticMessage += `\n  2. If using npx, ensure Node.js is installed`;
        diagnosticMessage += `\n  3. Check if the command path is correct`;
        if (this.config.command === "npx" && this.config.args?.[0]) {
          diagnosticMessage += `\n  4. Try installing the package: npm install -g ${this.config.args[0]}`;
        }
      } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission")) {
        diagnosticMessage += `\n❌ Permission denied for command: '${this.config.command}'`;
        diagnosticMessage += `\nPossible fixes:`;
        diagnosticMessage += `\n  1. Check file permissions: chmod +x ${this.config.command}`;
        diagnosticMessage += `\n  2. Ensure you have execute permissions`;
      } else if (errorMessage.includes("spawn")) {
        diagnosticMessage += `\n❌ Failed to spawn process`;
        diagnosticMessage += `\nCommand: ${this.config.command} ${this.config.args?.join(" ") || ""}`;
        diagnosticMessage += `\nWorking directory: ${this.config.cwd || process.cwd()}`;
      } else {
        diagnosticMessage += `\n❌ ${errorMessage}`;
      }
      
      // Check environment variables
      if (this.config.env) {
        const missingEnvVars = Object.entries(this.config.env)
          .filter(([_, value]) => !value || value === "")
          .map(([key]) => key);
        
        if (missingEnvVars.length > 0) {
          diagnosticMessage += `\n\n⚠️ Empty environment variables detected:`;
          missingEnvVars.forEach(key => {
            diagnosticMessage += `\n  - ${key}: Not set or empty`;
          });
        }
      }
      
      const enhancedError = new Error(diagnosticMessage);
      enhancedError.name = "MCPConnectionError";
      (enhancedError as any).originalError = error;
      (enhancedError as any).packageId = this.packageId;
      throw enhancedError;
    }
  }

  async listTools(): Promise<any[]> {
    logger.info("Listing tools from stdio MCP", {
      package_id: this.packageId,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.listTools();
        
        logger.info("Retrieved tools from stdio MCP", {
          package_id: this.packageId,
          tool_count: response.tools?.length || 0,
        });

        return response.tools || [];
      } catch (error) {
        logger.error("Failed to list tools from stdio MCP", {
          package_id: this.packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as Promise<any[]>;
  }

  async callTool(name: string, args: any): Promise<any> {
    // Get timeout from config or environment variable (default: 5 minutes)
    const timeout = this.config.timeout ||
                    parseInt(process.env.SUPER_MCP_TOOL_TIMEOUT || '300000');

    logger.info("Calling tool on stdio MCP", {
      package_id: this.packageId,
      tool_name: name,
      args_keys: typeof args === "object" && args ? Object.keys(args) : [],
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
          resetTimeoutOnProgress: true, // Reset timeout when progress notifications are received
        });

        logger.info("Tool call completed", {
          package_id: this.packageId,
          tool_name: name,
          has_content: !!(response && response.content),
        });

        // MCP client returns { content: [...] } directly
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
    // Get PID before closing (SDK exposes it via transport.pid)
    const pid = this.transport.pid;
    
    logger.info("Closing stdio MCP client", {
      package_id: this.packageId,
      pid,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    try {
      // Clear any pending requests in the queue
      this.requestQueue.clear();
      
      // IMPORTANT: Kill the process tree BEFORE SDK close, while PPID linkage is still valid.
      // The SDK's close() kills the spawned process, which causes children to be reparented
      // to PID 1 on Unix, making pkill -P ineffective. We must kill descendants first.
      if (pid) {
        logger.debug("Killing process tree before SDK close (while PPID linkage is valid)", { package_id: this.packageId, pid });
        await killProcessTree(pid);
      }
      
      // Now let the SDK clean up (will detect process already exited)
      await this.client.close();

      logger.info("Stdio MCP client closed", {
        package_id: this.packageId,
      });
    } catch (error) {
      logger.error("Error closing stdio MCP client", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async healthCheck(): Promise<"ok" | "error"> {
    try {
      // Try to list tools as a health check
      await this.listTools();
      return "ok";
    } catch (error) {
      logger.warn("Health check failed for stdio MCP", {
        package_id: this.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "error";
    }
  }

  async requiresAuth(): Promise<boolean> {
    // Stdio MCPs use environment variables for auth, handled at startup
    return false;
  }

  async isAuthenticated(): Promise<boolean> {
    // Stdio MCPs are authenticated via environment variables at startup
    return true;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    logger.info("Reading resource from stdio MCP", {
      package_id: this.packageId,
      uri,
      queue_size: this.requestQueue.size,
      queue_pending: this.requestQueue.pending,
    });

    return this.requestQueue.add(async () => {
      try {
        const response = await this.client.readResource({ uri });
        return { contents: response.contents || [] };
      } catch (error) {
        logger.error("Failed to read resource from stdio MCP", {
          package_id: this.packageId,
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as Promise<ReadResourceResult>;
  }

  supportsResources(): boolean {
    // Optimistically assume resources are supported; let the request fail if not
    return true;
  }
}