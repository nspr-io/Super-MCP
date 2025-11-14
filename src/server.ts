import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import {
  ERROR_CODES,
  ListToolPackagesInput,
  ListToolPackagesOutput,
  ListToolsInput,
  ListToolsOutput,
  UseToolInput,
  UseToolOutput,
  BeginAuthInput,
  BeginAuthOutput,
  AuthStatusInput,
  AuthStatusOutput,
} from "./types.js";
import { PackageRegistry } from "./registry.js";
import { Catalog } from "./catalog.js";
import { getValidator, ValidationError } from "./validator.js";
import { getLogger } from "./logging.js";

const logger = getLogger();

export async function startServer(options: {
  configPath?: string;
  configPaths?: string[];
  logLevel?: string;
  transport?: "stdio" | "http";
  port?: number;
}): Promise<void> {
  const { configPath, configPaths, logLevel = "info", transport = "stdio", port = 3000 } = options;
  
  // Handle both single and multiple config paths for backwards compatibility
  const paths = configPaths || (configPath ? [configPath] : ["super-mcp-config.json"]);

  // Initialize logger
  logger.setLevel(logLevel as any);
  
  logger.info("Starting Super MCP Router", {
    config_paths: paths,
    log_level: logLevel,
    transport_mode: transport,
    ...(transport === "http" && { port }),
  });

  try {
    // Start the OAuth callback server immediately (before any OAuth attempts)
    // OAuth is now handled by the MCP SDK directly
    
    // Load configuration and create registry
    const registry = await PackageRegistry.fromConfigFiles(paths);
    const catalog = new Catalog(registry);
    const validator = getValidator();
    const authManager = registry.getAuthManager();

    // Create MCP server
    const server = new Server(
      {
        name: "super-mcp-router",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Add meta-tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_tool_packages",
            description: "List available MCP packages and discover their capabilities. Start here to see what tools you have access to. Each package provides a set of related tools (e.g., filesystem operations, API integrations). Returns package IDs needed for list_tools.",
            inputSchema: {
              type: "object",
              properties: {
                safe_only: {
                  type: "boolean",
                  description: "Only return packages that are considered safe",
                  default: true,
                },
                limit: {
                  type: "number",
                  description: "Maximum number of packages to return",
                  default: 100,
                },
                include_health: {
                  type: "boolean",
                  description: "Include health status for each package (shows if package is connected and ready)",
                  default: true,
                },
              },
              examples: [
                { safe_only: true, include_health: true },
                { limit: 10 }
              ],
            },
          },
          {
            name: "list_tools",
            description: "Explore tools within a specific package to understand what actions you can perform. Use the package_id from list_tool_packages. Returns tool names, descriptions, and argument schemas. Essential for discovering available functionality before using use_tool.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "Package ID from list_tool_packages (e.g., 'filesystem', 'github', 'notion-api')",
                  examples: ["filesystem", "github", "notion-api", "brave-search"],
                },
                summarize: {
                  type: "boolean",
                  description: "Include summaries and argument skeletons showing expected format",
                  default: true,
                },
                include_schemas: {
                  type: "boolean",
                  description: "Include full JSON schemas for tool arguments (verbose, usually not needed)",
                  default: false,
                },
                page_size: {
                  type: "number",
                  description: "Number of tools to return per page",
                  default: 20,
                },
                page_token: {
                  type: ["string", "null"],
                  description: "Token for pagination (from previous response's next_page_token)",
                },
              },
              required: ["package_id"],
              examples: [
                { package_id: "filesystem", summarize: true },
                { package_id: "github", page_size: 10 }
              ],
            },
          },
          {
            name: "use_tool",
            description: "Execute a specific tool from a package. First use list_tool_packages to find packages, then list_tools to discover tools and their arguments, then use this to execute. The args must match the tool's schema exactly.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "Package ID containing the tool (from list_tool_packages)",
                  examples: ["filesystem", "github"],
                },
                tool_id: {
                  type: "string",
                  description: "Tool name/ID to execute (from list_tools)",
                  examples: ["read_file", "search_repositories", "create_page"],
                },
                args: {
                  type: "object",
                  description: "Tool-specific arguments matching the schema from list_tools",
                  examples: [
                    { path: "/Users/example/file.txt" },
                    { query: "language:python stars:>100" }
                  ],
                },
                dry_run: {
                  type: "boolean",
                  description: "Validate arguments without executing (useful for testing)",
                  default: false,
                },
              },
              required: ["package_id", "tool_id", "args"],
              examples: [
                { 
                  package_id: "filesystem", 
                  tool_id: "read_file", 
                  args: { path: "/tmp/test.txt" } 
                },
                {
                  package_id: "github",
                  tool_id: "search_repositories",
                  args: { query: "mcp tools", limit: 5 },
                  dry_run: true
                }
              ],
            },
          },
          {
            name: "get_help",
            description: "Get detailed guidance on using Super-MCP effectively. Provides step-by-step instructions, common workflows, troubleshooting tips, and best practices. Use this when you need clarification on how to accomplish tasks.",
            inputSchema: {
              type: "object",
              properties: {
                topic: {
                  type: "string",
                  description: "Help topic to explore",
                  enum: ["getting_started", "workflow", "authentication", "tool_discovery", "error_handling", "common_patterns", "package_types"],
                  default: "getting_started",
                },
                package_id: {
                  type: "string",
                  description: "Get package-specific help and usage patterns",
                  examples: ["filesystem", "github", "notion-api"],
                },
                error_code: {
                  type: "number",
                  description: "Get help for a specific error code",
                  examples: [-32001, -32002, -32003],
                },
              },
              examples: [
                { topic: "getting_started" },
                { topic: "workflow" },
                { package_id: "github" },
                { error_code: -32005 }
              ],
            },
          },
          {
            name: "health_check_all",
            description: "Check connection status and health of all configured packages. Useful for diagnosing issues or verifying which packages are available and authenticated. Shows which packages need authentication.",
            inputSchema: {
              type: "object",
              properties: {
                detailed: {
                  type: "boolean",
                  description: "Include detailed information for each package",
                  default: false,
                },
              },
            },
          },
          {
            name: "authenticate",
            description: "Start OAuth authentication for packages that require it (e.g., Notion, Slack). Opens browser for authorization. Use health_check_all first to see which packages need authentication.",
            inputSchema: {
              type: "object",
              properties: {
                package_id: {
                  type: "string",
                  description: "The package ID to authenticate (must be an OAuth-enabled package)",
                  examples: ["notion-api", "slack"],
                },
                wait_for_completion: {
                  type: "boolean",
                  description: "Whether to wait for OAuth completion before returning",
                  default: true,
                },
              },
              required: ["package_id"],
            },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "list_tool_packages":
            return await handleListToolPackages(args as any, registry, catalog);

          case "list_tools":
            return await handleListTools(args as any, catalog, validator);

          case "use_tool":
            return await handleUseTool(args as any, registry, catalog, validator);

          case "health_check_all":
            return await handleHealthCheckAll(args as any, registry);

          case "authenticate":
            return await handleAuthenticate(args as any, registry);

          case "get_help":
            return await handleGetHelp(args as any, registry);

          default:
            throw {
              code: ERROR_CODES.INVALID_PARAMS,
              message: `Unknown tool: ${name}`,
            };
        }
      } catch (error) {
        logger.error("Tool execution failed", {
          tool_name: name,
          error: error instanceof Error ? error.message : String(error),
        });

        if (error && typeof error === "object" && "code" in error) {
          // Enhance error messages with helpful guidance
          const errorCode = (error as any).code;
          let helpfulMessage = (error as any).message;
          
          // Add contextual help based on error code
          switch (errorCode) {
            case ERROR_CODES.PACKAGE_NOT_FOUND:
              helpfulMessage += ". Run 'list_tool_packages()' to see available packages.";
              break;
            case ERROR_CODES.TOOL_NOT_FOUND:
              helpfulMessage += ". Run 'list_tools(package_id: \"...\")' to see available tools.";
              break;
            case ERROR_CODES.ARG_VALIDATION_FAILED:
              helpfulMessage += ". Use 'dry_run: true' to test arguments or 'get_help(error_code: -32003)' for detailed guidance.";
              break;
            case ERROR_CODES.AUTH_REQUIRED:
              helpfulMessage += ". Run 'authenticate(package_id: \"...\")' to connect this package.";
              break;
            case ERROR_CODES.PACKAGE_UNAVAILABLE:
              helpfulMessage += ". Run 'health_check_all()' to diagnose the issue.";
              break;
            case ERROR_CODES.DOWNSTREAM_ERROR:
              helpfulMessage += ". Check 'get_help(error_code: -32007)' for troubleshooting steps.";
              break;
          }
          
          throw {
            ...error,
            message: helpfulMessage,
          };
        }

        throw {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: `${error instanceof Error ? error.message : String(error)}. Try 'get_help(topic: "error_handling")' for general troubleshooting.`,
          data: { tool_name: name },
        };
      }
    });

    // Create transport and connect based on mode
    if (transport === "http") {
      // HTTP mode: Create Express server with StreamableHTTP transport (stateless)
      const app = express();
      app.use(express.json());

      // Create stateless transport (no session management for parallel instances)
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });

      // Connect server to transport once
      await server.connect(httpTransport);

      // Health check endpoint
      app.get("/health", (_req, res) => {
        res.json({ status: "ok", transport: "http" });
      });

      // Main MCP endpoint - handles all MCP communication (POST for messages, GET for SSE)
      const mcpHandler = async (req: any, res: any) => {
        try {
          await httpTransport.handleRequest(req, res, req.body);
        } catch (error) {
          logger.error("Failed to handle MCP request", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
          }
        }
      };

      app.post("/mcp", mcpHandler);
      app.get("/mcp", mcpHandler); // For SSE streams

      const httpServer = app.listen(port, () => {
        logger.info("Super MCP Router started successfully", {
          transport: "http",
          port,
          endpoint: `http://localhost:${port}/mcp`,
        });
      });

      // Graceful shutdown for HTTP mode
      const shutdown = async () => {
        logger.info("Shutting down HTTP server...");
        httpServer.close(() => {
          logger.info("HTTP server closed");
        });
        await httpTransport.close();
        logger.info("HTTP transport closed");
        await registry.closeAll();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      // STDIO mode (default): Use standard input/output transport
      const stdioTransport = new StdioServerTransport();
      await server.connect(stdioTransport);

      logger.info("Super MCP Router started successfully", {
        transport: "stdio",
      });

      // Graceful shutdown for STDIO mode
      const shutdown = async () => {
        logger.info("Shutting down...");
        await registry.closeAll();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
    
  } catch (error) {
    logger.fatal("Failed to start server", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleListToolPackages(
  input: ListToolPackagesInput,
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  const { safe_only = true, limit = 100, include_health = true } = input;

  const packages = registry.getPackages({ safe_only }).slice(0, limit);
  
  const packageInfos = await Promise.all(
    packages.map(async (pkg) => {
      const toolCount = catalog.countTools(pkg.id);
      const health = include_health ? await registry.healthCheck(pkg.id) : undefined;
      const summary = await catalog.buildPackageSummary(pkg);

      const authMode: "env" | "oauth2" | "none" = pkg.transport === "http" 
        ? (pkg.auth?.mode ?? "none") 
        : "env";

      return {
        package_id: pkg.id,
        name: pkg.name,
        description: pkg.description,
        transport: pkg.transport,
        auth_mode: authMode,
        tool_count: toolCount,
        health,
        summary: pkg.description || summary,
        visibility: pkg.visibility,
      };
    })
  );

  const result: ListToolPackagesOutput = {
    packages: packageInfos,
    catalog_etag: catalog.etag(),
    updated_at: new Date().toISOString(),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}

async function handleListTools(
  input: ListToolsInput,
  catalog: Catalog,
  validator: any
): Promise<any> {
  const {
    package_id,
    summarize = true,
    include_schemas = false,
    page_size = 20,
    page_token,
  } = input;

  const toolInfos = await catalog.buildToolInfos(package_id, {
    summarize,
    include_schemas,
  });

  // Apply pagination
  const startIndex = page_token ? 
    Math.max(0, parseInt(Buffer.from(page_token, 'base64').toString('utf8'))) : 0;
  const endIndex = startIndex + page_size;
  const tools = toolInfos.slice(startIndex, endIndex);
  
  const nextToken = endIndex < toolInfos.length ? 
    Buffer.from(endIndex.toString()).toString('base64') : null;

  const result: ListToolsOutput = {
    tools,
    next_page_token: nextToken,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}

async function handleUseTool(
  input: UseToolInput,
  registry: PackageRegistry,
  catalog: Catalog,
  validator: any
): Promise<any> {
  let { package_id, tool_id, args, dry_run = false } = input;

  // Handle namespaced tool IDs for backward compatibility and Claude Code subagent support
  // Tool IDs now follow the format: "PackageName__tool_name"
  // This ensures global uniqueness when multiple packages have identically named tools

  // Case 1: tool_id is namespaced but package_id not provided (e.g., "filesystem__read_file")
  if (tool_id.includes('__') && !package_id) {
    const parts = tool_id.split('__');
    if (parts.length >= 2) {
      package_id = parts[0];
      tool_id = parts.slice(1).join('__'); // Preserve __ in original tool name if present
      logger.debug("Extracted package from namespaced tool_id", {
        original_tool_id: input.tool_id,
        extracted_package_id: package_id,
        extracted_tool_id: tool_id,
      });
    }
  }
  // Case 2: Both package_id provided AND tool_id is namespaced (strip namespace prefix)
  else if (package_id && tool_id.startsWith(`${package_id}__`)) {
    const originalToolId = tool_id;
    tool_id = tool_id.substring(package_id.length + 2); // Remove "PackageId__" prefix
    logger.debug("Stripped namespace prefix from tool_id", {
      original_tool_id: originalToolId,
      stripped_tool_id: tool_id,
      package_id,
    });
  }

  // Validate that the package exists
  const packageConfig = registry.getPackage(package_id);
  if (!packageConfig) {
    throw {
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      message: `Package not found: ${package_id}`,
      data: { package_id },
    };
  }

  // Get and validate the tool schema (using the original, un-namespaced tool name)
  const schema = await catalog.getToolSchema(package_id, tool_id);
  if (!schema) {
    throw {
      code: ERROR_CODES.TOOL_NOT_FOUND,
      message: `Tool not found: ${tool_id} in package ${package_id}`,
      data: { package_id, tool_id },
    };
  }

  // Handle dry run
  if (dry_run) {
    try {
      validator.validate(schema, args, { package_id, tool_id });
    } catch (error) {
      if (error instanceof ValidationError) {
        // Build a helpful error message
        let helpMessage = `Argument validation failed for tool '${tool_id}' in package '${package_id}'.\n`;
        helpMessage += `\n${error.message}\n`;
        
        // Add specific guidance based on validation errors
        if (error.errors && error.errors.length > 0) {
          helpMessage += `\nValidation errors:`;
          error.errors.forEach((err: any) => {
            const path = err.instancePath || "root";
            helpMessage += `\n  • ${path}: ${err.message}`;
            
            // Add specific suggestions
            if (err.keyword === "required") {
              helpMessage += ` (missing: ${err.params?.missingProperty})`;
            } else if (err.keyword === "type") {
              helpMessage += ` (expected: ${err.params?.type}, got: ${typeof err.data})`;
            } else if (err.keyword === "enum") {
              helpMessage += ` (allowed values: ${err.params?.allowedValues?.join(", ")})`;
            }
          });
        }
        
        helpMessage += `\n\nTo see the correct schema, run:`;
        helpMessage += `\n  list_tools(package_id: "${package_id}", include_schemas: true)`;
        helpMessage += `\n\nTo test your arguments without executing:`;
        helpMessage += `\n  use_tool(package_id: "${package_id}", tool_id: "${tool_id}", args: {...}, dry_run: true)`;
        
        throw {
          code: ERROR_CODES.ARG_VALIDATION_FAILED,
          message: helpMessage,
          data: {
            package_id,
            tool_id,
            errors: error.errors,
            provided_args: args ? Object.keys(args) : [],
          },
        };
      }
      throw error;
    }

    const result: UseToolOutput = {
      package_id,
      tool_id,
      args_used: args,
      result: { dry_run: true },
      telemetry: { duration_ms: 0, status: "ok" },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: false,
    };
  }

  // Execute the tool
  const startTime = Date.now();
  try {
    const client = await registry.getClient(package_id);
    const toolResult = await client.callTool(tool_id, args);
    const duration = Date.now() - startTime;

    const result: UseToolOutput = {
      package_id,
      tool_id,
      args_used: args,
      result: toolResult,
      telemetry: { duration_ms: duration, status: "ok" },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: false,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (error instanceof McpError && error.code === SdkErrorCode.InvalidParams) {
      throw {
        code: ERROR_CODES.ARG_VALIDATION_FAILED,
        message: error.message,
        data: {
          package_id,
          tool_id,
          duration_ms: duration,
          args_provided: args ? Object.keys(args) : [],
          mcp_error_code: error.code,
          mcp_error_data: error.data,
        },
      };
    }
    
    // Build helpful diagnostic message
    let diagnosticMessage = `Tool execution failed in package '${package_id}', tool '${tool_id}'.\n`;
    
    // Add specific error context
    if (errorMessage.includes("not found") || errorMessage.includes("undefined")) {
      diagnosticMessage += `\n❌ Tool might not exist or package not properly connected`;
      diagnosticMessage += `\nTroubleshooting:`;
      diagnosticMessage += `\n  1. Run 'health_check_all()' to verify package status`;
      diagnosticMessage += `\n  2. Run 'list_tools(package_id: "${package_id}")' to see available tools`;
      diagnosticMessage += `\n  3. Check if the tool name is correct (case-sensitive)`;
    } else if (errorMessage.includes("timeout")) {
      diagnosticMessage += `\n❌ Tool execution timed out after ${duration}ms`;
      diagnosticMessage += `\nThis might indicate:`;
      diagnosticMessage += `\n  1. The operation is taking longer than expected`;
      diagnosticMessage += `\n  2. The MCP server is not responding`;
      diagnosticMessage += `\n  3. Network issues (for HTTP-based MCPs)`;
    } else if (errorMessage.includes("permission") || errorMessage.includes("denied")) {
      diagnosticMessage += `\n❌ Permission denied`;
      diagnosticMessage += `\nPossible causes:`;
      diagnosticMessage += `\n  1. Insufficient permissions for the requested operation`;
      diagnosticMessage += `\n  2. API key/token lacks required scopes`;
      diagnosticMessage += `\n  3. File system permissions (for filesystem MCPs)`;
    } else if (errorMessage.includes("auth") || errorMessage.includes("401") || errorMessage.includes("403")) {
      diagnosticMessage += `\n❌ Authentication/Authorization error`;
      diagnosticMessage += `\nTroubleshooting:`;
      diagnosticMessage += `\n  1. Check if API keys/tokens are valid`;
      diagnosticMessage += `\n  2. Run 'authenticate(package_id: "${package_id}")' if OAuth-based`;
      diagnosticMessage += `\n  3. Verify credentials have required permissions`;
    } else {
      diagnosticMessage += `\n❌ ${errorMessage}`;
    }
    
    // Add execution context
    diagnosticMessage += `\n\nExecution context:`;
    diagnosticMessage += `\n  Package: ${package_id}`;
    diagnosticMessage += `\n  Tool: ${tool_id}`;
    diagnosticMessage += `\n  Duration: ${duration}ms`;
    if (args && Object.keys(args).length > 0) {
      diagnosticMessage += `\n  Arguments provided: ${Object.keys(args).join(", ")}`;
    }
    
    throw {
      code: ERROR_CODES.DOWNSTREAM_ERROR,
      message: diagnosticMessage,
      data: {
        package_id,
        tool_id,
        duration_ms: duration,
        original_error: errorMessage,
        args_provided: args ? Object.keys(args) : [],
      },
    };
  }
}


async function handleAuthStatus(
  input: AuthStatusInput,
  registry: PackageRegistry,
  authManager: any
): Promise<any> {
  const { package_id } = input;

  const packageConfig = registry.getPackage(package_id);
  if (!packageConfig) {
    throw {
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      message: `Package not found: ${package_id}`,
      data: { package_id },
    };
  }

  // For stdio packages (local MCPs), authentication is handled via environment/files
  if (packageConfig.transport === "stdio") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ state: "authorized" }, null, 2),
        },
      ],
      isError: false,
    };
  }

  // For HTTP packages without auth config, no authentication needed
  if (packageConfig.transport === "http" && !packageConfig.auth) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ state: "authorized" }, null, 2),
        },
      ],
      isError: false,
    };
  }

  // For HTTP packages with auth config, check actual auth status
  try {
    // For OAuth packages, check if tokens exist and if we can connect
    if (packageConfig.oauth) {
      const client = await registry.getClient(package_id);
      const health = client.healthCheck ? await client.healthCheck() : "ok";
      
      if (health === "ok") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ state: "authorized", connected: true }, null, 2),
            },
          ],
          isError: false,
        };
      } else {
        // Health check failed - needs auth
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ state: "unauthorized", connected: false }, null, 2),
            },
          ],
          isError: false,
        };
      }
    }
    
    const result = await authManager.getAuthStatus(package_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: false,
    };
  } catch (error) {
    throw {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: `Failed to get auth status: ${error instanceof Error ? error.message : String(error)}`,
      data: { package_id },
    };
  }
}

async function handleHealthCheckAll(
  input: { detailed?: boolean },
  registry: PackageRegistry
): Promise<any> {
  const { detailed = false } = input;

  logger.info("Performing health check on all packages");

  const packages = registry.getPackages({ safe_only: false });
  const results = await Promise.all(
    packages.map(async (pkg) => {
      try {
        const health = await registry.healthCheck(pkg.id);
        const client = await registry.getClient(pkg.id);
        const requiresAuth = client.requiresAuth ? await client.requiresAuth() : false;
        const isAuthenticated = requiresAuth && client.isAuthenticated ? await client.isAuthenticated() : true;

        const result: any = {
          package_id: pkg.id,
          name: pkg.name,
          transport: pkg.transport,
          status: health,
          requires_auth: requiresAuth,
          is_authenticated: isAuthenticated,
        };
        
        // Add diagnostic information for problematic packages
        if (health !== "ok") {
          result.diagnostic = "Package is not healthy";
          
          if (health === "unavailable") {
            result.suggested_actions = [];
            if (pkg.transport === "stdio") {
              result.suggested_actions.push(`Check if '${pkg.command}' is installed`);
              if (pkg.command === "npx" && pkg.args?.[0]) {
                result.suggested_actions.push(`Try: npm install -g ${pkg.args[0]}`);
              }
            } else if (pkg.transport === "http") {
              result.suggested_actions.push(`Check network connectivity to ${pkg.base_url}`);
              if (requiresAuth && !isAuthenticated) {
                result.suggested_actions.push(`Run: authenticate(package_id: "${pkg.id}")`);
              }
            }
          }
        }
        
        // Check for environment variable issues
        if (pkg.env) {
          const envIssues: string[] = [];
          for (const [key, value] of Object.entries(pkg.env)) {
            if (!value || value === "" || value.includes("YOUR_") || value.startsWith("${")) {
              envIssues.push(`${key} appears unset or invalid`);
            }
          }
          if (envIssues.length > 0) {
            result.env_issues = envIssues;
          }
        }

        if (detailed) {
          result.description = pkg.description;
          result.visibility = pkg.visibility;
          if (pkg.transport === "http") {
            result.base_url = pkg.base_url;
          }
          if (pkg.transport === "stdio") {
            result.command = pkg.command;
            result.args = pkg.args;
          }
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const diagnostic: any = {
          package_id: pkg.id,
          name: pkg.name,
          transport: pkg.transport,
          status: "error",
          error: errorMessage,
          diagnostic: "Failed to check package health",
          suggested_actions: []
        };
        
        // Add specific suggestions based on error
        if (errorMessage.includes("ENOENT") || errorMessage.includes("not found")) {
          diagnostic.suggested_actions.push(`Install the MCP server: ${pkg.command}`);
        } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission")) {
          diagnostic.suggested_actions.push(`Check file permissions for: ${pkg.command}`);
        } else if (errorMessage.includes("auth")) {
          diagnostic.suggested_actions.push(`Check authentication credentials`);
        }
        
        return diagnostic;
      }
    })
  );

  const summary = {
    total: results.length,
    healthy: results.filter((r) => r.status === "ok").length,
    errored: results.filter((r) => r.status === "error").length,
    unavailable: results.filter((r) => r.status === "unavailable").length,
    requiring_auth: results.filter((r) => r.requires_auth).length,
    authenticated: results.filter((r) => r.is_authenticated).length,
    with_env_issues: results.filter((r) => r.env_issues && r.env_issues.length > 0).length,
  };
  
  // Add overall recommendations
  const recommendations: string[] = [];
  if (summary.errored > 0) {
    recommendations.push("Some packages have errors - check the 'suggested_actions' for each");
  }
  if (summary.unavailable > 0) {
    recommendations.push("Some packages are unavailable - they may need installation or authentication");
  }
  if (summary.with_env_issues > 0) {
    recommendations.push("Some packages have environment variable issues - check 'env_issues' for details");
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ 
          summary, 
          recommendations: recommendations.length > 0 ? recommendations : undefined,
          packages: results 
        }, null, 2),
      },
    ],
    isError: false,
  };
}

// OAuth is now handled automatically by the MCP SDK
// This function is kept for backward compatibility but simplified
async function handleAuthenticate(
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
  
  // Check if it's a stdio package (no auth needed)
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
    // First check if already authenticated and connected
    logger.info("Checking if already authenticated", { package_id });
    const client = await registry.getClient(package_id);
    const health = client.healthCheck ? await client.healthCheck() : "ok";
    logger.info("Client health check", { package_id, health });
    
    if (health === "ok") {
      // Already connected, check if we can list tools
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
        // Fall through to re-authenticate
      }
    }
  } catch (error) {
    logger.info("Client not available or errored", { 
      package_id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Continue with auth
  }
  
  // Trigger OAuth explicitly for HTTP packages  
  try {
    // Start OAuth callback server first (only if waiting for completion)
    let callbackServer: any = null;
    
    if (wait_for_completion) {
      const { OAuthCallbackServer } = await import("./auth/callbackServer.js");
      callbackServer = new OAuthCallbackServer();
      
      try {
        await callbackServer.start();
        logger.info("OAuth callback server started", { package_id });
        
        // Give the server a moment to be fully ready
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
    
    // Clear existing client to force reconnection
    const clients = (registry as any).clients as Map<string, any>;
    clients.delete(package_id);
    
    // Create a new HTTP client with OAuth enabled
    logger.info("Creating HTTP client with OAuth enabled", { package_id });
    const { HttpMcpClient } = await import("./clients/httpClient.js");
    const httpClient = new HttpMcpClient(package_id, pkg);
    
    // Trigger OAuth connection
    logger.info("Triggering OAuth connection", { package_id });
    
    // Try to connect with OAuth - this will open the browser
    const connectPromise = httpClient.connectWithOAuth();
    
    if (wait_for_completion && callbackServer) {
      // Wait for OAuth callback or timeout  
      logger.info("Waiting for OAuth callback", { package_id });
      
      try {
        // Start two promises:
        // 1. The OAuth connection attempt (will fail with redirect)
        // 2. Wait for the callback with the authorization code
        
        connectPromise.catch(err => {
          // Expected to fail with redirect error
          logger.debug("OAuth redirect initiated (expected)", {
            package_id,
            error: err instanceof Error ? err.message : String(err)
          });
        });
        
        // Wait for the callback to receive the authorization code
        const callbackPromise = callbackServer.waitForCallback(60000);
        
        const authCode = await callbackPromise;
        logger.info("OAuth callback received", { package_id, has_code: !!authCode });
        
        // Use the SDK's finishAuth to complete the OAuth flow
        logger.info("Exchanging authorization code for tokens", { package_id });
        await httpClient.finishOAuth(authCode);
        
        // Now the client should be connected with OAuth tokens
        logger.info("OAuth flow completed, checking connection", { package_id });
        
        // Store the connected client
        clients.set(package_id, httpClient);
        
        // Check if it worked
        const health = httpClient.healthCheck ? await httpClient.healthCheck() : "ok";
        
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
          throw new Error("Authentication succeeded but connection failed");
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
      // Don't wait, just trigger and return
      connectPromise.catch(err => {
        logger.debug("OAuth connection error (expected)", { 
          package_id,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }
    
    // Store the client even if not fully connected
    clients.set(package_id, httpClient);
    
    // Check current health
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

async function handleReconnectPackage(
  input: { package_id: string },
  registry: PackageRegistry
): Promise<any> {
  const { package_id } = input;
  
  logger.info("Attempting to reconnect package", { package_id });
  
  try {
    // Clear any existing client
    const clients = (registry as any).clients as Map<string, any>;
    clients.delete(package_id);
    
    // Clear transport pool for this package
    // const { TransportPool } = await import("./clients/transportPool.js");
    // const pool = TransportPool.getInstance();
    const pkg = registry.getPackage(package_id);
    if (pkg?.base_url) {
      // pool.clearTransport(package_id, pkg.base_url);
    }
    
    // Try to get a new client (will trigger reconnection)
    const client = await registry.getClient(package_id);
    const health = client.healthCheck ? await client.healthCheck() : "ok";
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id,
            status: health === "ok" ? "reconnected" : "failed",
            health,
          }, null, 2),
        },
      ],
      isError: false,
    };
  } catch (error) {
    logger.error("Failed to reconnect package", {
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
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        },
      ],
      isError: false,
    };
  }
}

async function handleAuthenticateAll(
  input: { skip_authenticated?: boolean; wait_for_completion?: boolean },
  registry: PackageRegistry
): Promise<any> {
  const { skip_authenticated = true, wait_for_completion = true } = input;

  logger.info("Attempting to authenticate all packages", {
    skip_authenticated,
    wait_for_completion,
  });
  
  // Ensure callback server is running
  // const { SimpleOAuthProvider } = await import("./auth/simpleOAuthProvider.js");
  // await SimpleOAuthProvider.startGlobalCallbackServer();
  logger.info("OAuth callback server ready on port 5173");

  const packages = registry.getPackages({ safe_only: false });
  const results = [];

  for (const pkg of packages) {
    // Skip stdio packages
    if (pkg.transport === "stdio") {
      results.push({
        package_id: pkg.id,
        name: pkg.name,
        status: "skipped",
        reason: "stdio packages don't require authentication",
      });
      continue;
    }
    
    // Only process OAuth packages
    if (!pkg.oauth) {
      results.push({
        package_id: pkg.id,
        name: pkg.name,
        status: "skipped",
        reason: "not an OAuth package",
      });
      continue;
    }
    
    // Check if already authenticated
    if (skip_authenticated) {
      try {
        const client = await registry.getClient(pkg.id);
        const health = client.healthCheck ? await client.healthCheck() : "ok";
        
        if (health === "ok") {
          try {
            await client.listTools();
            results.push({
              package_id: pkg.id,
              name: pkg.name,
              status: "already_authenticated",
              message: "Package is already authenticated and connected",
            });
            continue;
          } catch {
            // Need to authenticate
          }
        }
      } catch {
        // Need to authenticate
      }
    }
    
    // Authenticate this package
    console.log(`\n📦 Authenticating ${pkg.name}...`);
    
    const authResult = await handleAuthenticate(
      { package_id: pkg.id, wait_for_completion },
      registry
    );
    
    // Parse the result
    try {
      const resultData = JSON.parse(authResult.content[0].text);
      results.push({
        package_id: pkg.id,
        name: pkg.name,
        ...resultData,
      });
    } catch {
      results.push({
        package_id: pkg.id,
        name: pkg.name,
        status: "error",
        message: "Failed to authenticate",
      });
    }
  }
  
  const summary = {
    total: results.length,
    skipped: results.filter(r => r.status === "skipped").length,
    already_authenticated: results.filter(r => r.status === "already_authenticated").length,
    authenticated: results.filter(r => r.status === "authenticated" || r.status === "reconnected").length,
    errors: results.filter(r => r.status === "error").length,
  };
  
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ summary, results }, null, 2),
      },
    ],
    isError: false,
  };
}

async function handleGetHelp(
  input: { topic?: string; package_id?: string; error_code?: number },
  registry: PackageRegistry
): Promise<any> {
  const { topic = "getting_started", package_id, error_code } = input;

  let helpContent = "";

  // Handle error code help
  if (error_code !== undefined) {
    helpContent = getErrorHelp(error_code);
  }
  // Handle package-specific help
  else if (package_id) {
    helpContent = await getPackageHelp(package_id, registry);
  }
  // Handle topic help
  else {
    helpContent = getTopicHelp(topic);
  }

  return {
    content: [
      {
        type: "text",
        text: helpContent,
      },
    ],
    isError: false,
  };
}

function getTopicHelp(topic: string): string {
  const helpTopics: Record<string, string> = {
    getting_started: `# Getting Started with Super-MCP

Super-MCP provides a unified interface to multiple MCP (Model Context Protocol) packages. Here's how to use it effectively:

## Basic Workflow
1. **Discover Packages**: Use \`list_tool_packages\` to see available MCP packages
2. **Explore Tools**: Use \`list_tools\` with a package_id to discover tools in that package
3. **Execute Tools**: Use \`use_tool\` to run a specific tool with appropriate arguments

## Example Flow
\`\`\`
1. list_tool_packages() → See all available packages
2. list_tools(package_id: "filesystem") → See filesystem tools
3. use_tool(package_id: "filesystem", tool_id: "read_file", args: {path: "/tmp/test.txt"})
\`\`\`

## Tips
- Always check package health with \`health_check_all\` if tools aren't working
- Some packages require authentication - use \`authenticate\` when needed
- Use \`dry_run: true\` in use_tool to validate arguments without executing`,

    workflow: `# Super-MCP Workflow Patterns

## Discovery Flow
1. Start with \`list_tool_packages\` to understand available capabilities
2. Note the package_id values for packages you want to use
3. Use \`list_tools\` to explore each package's functionality
4. Review the argument schemas carefully before using tools

## Common Patterns

### File Operations
- Package: usually "filesystem" or similar
- Common tools: read_file, write_file, list_directory
- Always use absolute paths

### API Integrations
- Packages: "github", "notion-api", "slack", etc.
- May require authentication via \`authenticate\`
- Check health_check_all to verify connection status

### Search Operations
- Look for packages with "search" in the name
- Tools often have query parameters with specific syntax
- Use dry_run to test complex queries

## Error Recovery
- If a tool fails, check the error message for guidance
- Use \`get_help(error_code: <code>)\` for specific error help
- Verify authentication status for API packages
- Check argument types match the schema exactly`,

    authentication: `# Authentication in Super-MCP

## Overview
Some MCP packages require authentication to access their APIs (e.g., Notion, Slack, GitHub private repos).

## How to Authenticate
1. **Check Status**: Run \`health_check_all\` to see which packages need auth
2. **Start Auth**: Use \`authenticate(package_id: "package-name")\`
3. **Complete in Browser**: A browser window opens for authorization
4. **Verify**: Run \`health_check_all\` again to confirm authentication

## Package Types
- **Local (stdio)**: No authentication needed, runs locally
- **Public APIs**: May work without auth but with limitations
- **Private APIs**: Always require authentication (OAuth)

## Troubleshooting
- If authentication fails, try again - OAuth tokens can expire
- Some packages store tokens securely and remember authentication
- Check package documentation for specific auth requirements`,

    tool_discovery: `# Discovering Tools in Super-MCP

## Understanding Package Structure
Each package contains related tools:
- **filesystem**: File and directory operations
- **github**: Repository, issue, and PR management
- **notion-api**: Page and database operations
- **brave-search**: Web search capabilities

## Using list_tools Effectively
\`\`\`
list_tools(package_id: "github", summarize: true)
\`\`\`

Returns:
- Tool names and descriptions
- Argument skeletons showing expected format
- Schema hashes for validation

## Reading Tool Schemas
- Required fields are marked in the schema
- Check type constraints (string, number, boolean, object, array)
- Note any enum values for restricted options
- Look for format hints (uri, email, date)

## Tips
- Start with summarize: true for readable format
- Use include_schemas: true only when debugging
- Page through results if a package has many tools`,

    error_handling: `# Error Handling in Super-MCP

## Common Error Codes

### -32001: PACKAGE_NOT_FOUND
- The package_id doesn't exist
- Solution: Use \`list_tool_packages\` to see valid package IDs

### -32002: TOOL_NOT_FOUND
- The tool_id doesn't exist in the specified package
- Solution: Use \`list_tools(package_id)\` to see valid tool IDs

### -32003: ARG_VALIDATION_FAILED
- Arguments don't match the tool's schema
- Solution: Check the schema and ensure types match exactly
- Use dry_run: true to test arguments

### -32004: PACKAGE_UNAVAILABLE
- Package is configured but not responding
- Solution: Check \`health_check_all\` and verify configuration

### -32005: AUTH_REQUIRED
- Package needs authentication
- Solution: Use \`authenticate(package_id)\`

### -32007: DOWNSTREAM_ERROR
- The underlying MCP server returned an error
- Solution: Check error details and tool documentation

## Best Practices
- Always validate arguments match the schema
- Use dry_run for testing complex operations
- Check health status before troubleshooting
- Read error messages carefully - they often contain the solution`,

    common_patterns: `# Common Patterns in Super-MCP

## File Management Pattern
\`\`\`
1. list_tools(package_id: "filesystem")
2. use_tool(package_id: "filesystem", tool_id: "list_directory", args: {path: "/tmp"})
3. use_tool(package_id: "filesystem", tool_id: "read_file", args: {path: "/tmp/data.txt"})
4. use_tool(package_id: "filesystem", tool_id: "write_file", args: {path: "/tmp/output.txt", content: "..."})
\`\`\`

## API Search Pattern
\`\`\`
1. authenticate(package_id: "github")  // If needed
2. use_tool(package_id: "github", tool_id: "search_repositories", args: {query: "language:python"})
3. use_tool(package_id: "github", tool_id: "get_repository", args: {owner: "...", repo: "..."})
\`\`\`

## Data Processing Pattern
\`\`\`
1. Read data from one source
2. Process/transform the data
3. Write to another destination
4. Verify the operation succeeded
\`\`\`

## Diagnostic Pattern
\`\`\`
1. health_check_all(detailed: true)
2. Identify problematic packages
3. authenticate() if needed
4. Retry failed operations
\`\`\``,

    package_types: `# Package Types in Super-MCP

## Local (stdio) Packages
- Run as local processes on your machine
- No network latency
- Full access to local filesystem (with permissions)
- Examples: filesystem, git, docker
- Configuration: command and args

## HTTP/SSE Packages
- Connect to remote MCP servers
- May require authentication (OAuth)
- Subject to network latency and limits
- Examples: notion-api, slack, cloud services
- Configuration: url and optional headers

## Package Capabilities
Different packages offer different capabilities:

### Data Access
- filesystem: Local file operations
- database packages: SQL queries
- API packages: Cloud service data

### Automation
- git: Version control operations
- docker: Container management
- ci/cd packages: Pipeline control

### Integration
- notion-api: Workspace management
- slack: Communication automation
- github: Repository management

## Choosing Packages
- Use local packages for file/system operations
- Use HTTP packages for cloud services
- Check authentication requirements upfront
- Consider rate limits for API packages`,
  };

  return helpTopics[topic] || `Unknown help topic: ${topic}. Available topics: ${Object.keys(helpTopics).join(", ")}`;
}

function getErrorHelp(errorCode: number): string {
  const errorHelp: Record<number, string> = {
    [-32001]: `# Error -32001: PACKAGE_NOT_FOUND

This error means the package_id you specified doesn't exist.

## How to Fix
1. Run \`list_tool_packages()\` to see all available packages
2. Copy the exact package_id from the response
3. Use that package_id in your request

## Common Causes
- Typo in package_id
- Package not configured in super-mcp-config.json
- Using tool name instead of package_id`,

    [-32002]: `# Error -32002: TOOL_NOT_FOUND

The tool_id doesn't exist in the specified package.

## How to Fix
1. Run \`list_tools(package_id: "your-package")\` 
2. Find the correct tool_id from the response
3. Use the exact tool name/id

## Common Causes
- Wrong package selected
- Tool name changed or deprecated
- Case sensitivity issues`,

    [-32003]: `# Error -32003: ARG_VALIDATION_FAILED

The arguments provided don't match the tool's expected schema.

## How to Fix
1. Run \`list_tools(package_id: "...", include_schemas: true)\`
2. Review the exact schema requirements
3. Ensure all required fields are present
4. Check that types match exactly (string vs number)
5. Use \`dry_run: true\` to test

## Common Issues
- Missing required fields
- Wrong data types (sending string instead of number)
- Invalid enum values
- Incorrect nesting of objects`,

    [-32004]: `# Error -32004: PACKAGE_UNAVAILABLE

The package exists but isn't responding.

## How to Fix
1. Run \`health_check_all()\` to check status
2. If it shows "error", check your configuration
3. For local packages, ensure the command is installed
4. For HTTP packages, check network connectivity

## Common Causes
- Local MCP server not installed
- Network issues for HTTP packages
- Incorrect configuration in super-mcp-config.json`,

    [-32005]: `# Error -32005: AUTH_REQUIRED

The package requires authentication before use.

## How to Fix
1. Run \`authenticate(package_id: "package-name")\`
2. Complete OAuth flow in browser
3. Try your operation again

## Notes
- Some packages require API keys in config
- OAuth tokens may expire and need refresh
- Check package documentation for auth setup`,

    [-32007]: `# Error -32007: DOWNSTREAM_ERROR

The underlying MCP server returned an error.

## How to Fix
1. Read the error message details carefully
2. Check if it's an auth issue (401/403)
3. Verify the operation is valid for that package
4. Check package-specific documentation

## Common Causes
- Expired authentication tokens
- Rate limiting
- Invalid operations for the package
- Permissions issues`,
  };

  const help = errorHelp[errorCode];
  if (help) {
    return help;
  }

  return `# Error Code ${errorCode}

This error code is not specifically documented.

## General Troubleshooting
1. Check the error message for details
2. Run \`health_check_all()\` to verify package status
3. Use \`list_tools\` to verify the tool exists
4. Validate arguments with \`dry_run: true\`
5. Check if authentication is needed

For more help, try:
- \`get_help(topic: "error_handling")\`
- \`get_help(topic: "workflow")\``;
}

async function getPackageHelp(packageId: string, registry: PackageRegistry): Promise<string> {
  try {
    const pkg = registry.getPackage(packageId);
    if (!pkg) {
      return `# Package Not Found: ${packageId}

The package "${packageId}" doesn't exist.

Run \`list_tool_packages()\` to see available packages.`;
    }

    const catalog = new Catalog(registry);
    let toolCount = 0;
    let toolExamples = "";
    
    try {
      const tools = await catalog.getPackageTools(packageId);
      toolCount = tools.length;
      
      if (tools.length > 0) {
        const exampleTools = tools.slice(0, 5).map(t => `- ${t.tool.name}: ${t.tool.description || 'No description'}`).join('\n');
        toolExamples = `
## Available Tools (showing first 5 of ${toolCount})
${exampleTools}

Use \`list_tools(package_id: "${packageId}")\` to see all tools.`;
      }
    } catch (error) {
      logger.debug("Could not load tools for help", { package_id: packageId });
      toolExamples = `
## Tools
Unable to load tools. The package may require authentication.
Use \`authenticate(package_id: "${packageId}")\` if needed.`;
    }

    const authInfo = pkg.transport === "http" && pkg.oauth 
      ? `
## Authentication
This package requires OAuth authentication.
Use \`authenticate(package_id: "${packageId}")\` to connect.`
      : pkg.transport === "stdio"
      ? `
## Authentication
This is a local package - no authentication needed.`
      : "";

    return `# Package: ${pkg.name || packageId}

${pkg.description || 'No description available'}

## Basic Info
- **ID**: ${packageId}
- **Type**: ${pkg.transport}
- **Status**: Run \`health_check_all()\` to check
${pkg.transport === "http" ? `- **URL**: ${pkg.base_url || 'Not specified'}` : ''}
${toolExamples}
${authInfo}

## Usage Example
\`\`\`
// 1. List available tools
list_tools(package_id: "${packageId}")

// 2. Execute a tool
use_tool(
  package_id: "${packageId}",
  tool_id: "tool_name",
  args: { /* tool-specific arguments */ }
)
\`\`\`

## Troubleshooting
- If tools aren't working, check \`health_check_all()\`
- For detailed schemas: \`list_tools(package_id: "${packageId}", include_schemas: true)\`
- Test arguments: Add \`dry_run: true\` to use_tool`;

  } catch (error) {
    return `Error generating help for package ${packageId}: ${error instanceof Error ? error.message : String(error)}`;
  }
}