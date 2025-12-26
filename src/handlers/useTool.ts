import { UseToolInput, UseToolOutput, ERROR_CODES } from "../types.js";
import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { ValidationError } from "../validator.js";
import { McpError, ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "../logging.js";
import { getSecurityPolicy } from "../security.js";

const logger = getLogger();
const LARGE_OUTPUT_WARNING_THRESHOLD = 150_000;

export async function handleUseTool(
  input: UseToolInput,
  registry: PackageRegistry,
  catalog: Catalog,
  validator: any
): Promise<any> {
  let { package_id, tool_id, args, dry_run = false, max_output_chars } = input;

  // Handle namespaced tool IDs for backward compatibility and Claude Code subagent support
  // Tool IDs now follow the format: "PackageName__tool_name"
  // This ensures global uniqueness when multiple packages have identically named tools

  // Case 1: tool_id is namespaced but package_id not provided (e.g., "filesystem__read_file")
  if (tool_id.includes('__') && !package_id) {
    const parts = tool_id.split('__');
    if (parts.length >= 2) {
      package_id = parts[0];
      tool_id = parts.slice(1).join('__');
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
    tool_id = tool_id.substring(package_id.length + 2);
    logger.debug("Stripped namespace prefix from tool_id", {
      original_tool_id: originalToolId,
      stripped_tool_id: tool_id,
      package_id,
    });
  }

  // Check if tool is blocked by security policy
  const securityPolicy = getSecurityPolicy();
  const blockCheck = securityPolicy.isToolBlocked(package_id, tool_id);
  if (blockCheck.blocked) {
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: blockCheck.reason || `Tool '${package_id}__${tool_id}' is blocked by security policy`,
      data: { package_id, tool_id, blocked_reason: blockCheck.reason },
    };
  }

  const packageConfig = registry.getPackage(package_id);
  if (!packageConfig) {
    throw {
      code: ERROR_CODES.PACKAGE_NOT_FOUND,
      message: `Package not found: ${package_id}`,
      data: { package_id },
    };
  }

  await catalog.ensurePackageLoaded(package_id);
  const packageStatus = catalog.getPackageStatus(package_id);
  if (packageStatus === "auth_required") {
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' requires authentication. Run 'authenticate(package_id: "${package_id}")'.`,
      data: { package_id, status: packageStatus },
    };
  }
  if (packageStatus === "error") {
    const reason = catalog.getPackageError(package_id) || "See logs for details";
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' is unavailable: ${reason}`,
      data: { package_id, status: packageStatus },
    };
  }

  const schema = await catalog.getToolSchema(package_id, tool_id);
  if (!schema) {
    throw {
      code: ERROR_CODES.TOOL_NOT_FOUND,
      message: `Tool not found: ${tool_id} in package ${package_id}`,
      data: { package_id, tool_id },
    };
  }

  // Validate arguments unconditionally (before checking dry_run)
  try {
    validator.validate(schema, args, { package_id, tool_id });
  } catch (error) {
    if (error instanceof ValidationError) {
      let helpMessage = `Argument validation failed for tool '${tool_id}' in package '${package_id}'.\n`;
      helpMessage += `\n${error.message}\n`;
      
      if (error.errors && error.errors.length > 0) {
        helpMessage += `\nValidation errors:`;
        error.errors.forEach((err: any) => {
          const path = err.instancePath || "root";
          helpMessage += `\n  • ${path}: ${err.message}`;
          
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

  if (dry_run) {
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

    let outputJson = JSON.stringify(result, null, 2);
    const originalOutputChars = outputJson.length;
    const estimatedTokens = Math.ceil(originalOutputChars / 4);

    if (max_output_chars && originalOutputChars > max_output_chars) {
      const truncatedJson = outputJson.slice(0, max_output_chars);
      
      result.telemetry.output_truncated = true;
      result.telemetry.original_output_chars = originalOutputChars;
      result.telemetry.output_chars = max_output_chars;
      
      outputJson = truncatedJson + `\n\n[OUTPUT TRUNCATED: Showing ${max_output_chars.toLocaleString()} of ${originalOutputChars.toLocaleString()} characters (~${estimatedTokens.toLocaleString()} tokens). To get the complete output, retry without max_output_chars or with a higher limit.]`;
      
      logger.warn("Tool output truncated", {
        package_id,
        tool_id,
        original_chars: originalOutputChars,
        truncated_to: max_output_chars,
        estimated_tokens: estimatedTokens,
      });
    }
    else if (!max_output_chars && originalOutputChars > LARGE_OUTPUT_WARNING_THRESHOLD) {
      result.telemetry.output_chars = originalOutputChars;
      
      outputJson = JSON.stringify(result, null, 2);
      outputJson += `\n\n---\n⚠️ LARGE OUTPUT WARNING: This response contains ${originalOutputChars.toLocaleString()} characters (~${estimatedTokens.toLocaleString()} tokens).\nIf this causes context overflow errors, you can retry with the max_output_chars parameter to limit the output size.\nExample: use_tool({ package_id: "${package_id}", tool_id: "${tool_id}", args: {...}, max_output_chars: 50000 })`;
      
      logger.info("Large tool output detected", {
        package_id,
        tool_id,
        output_chars: originalOutputChars,
        estimated_tokens: estimatedTokens,
        warning_threshold: LARGE_OUTPUT_WARNING_THRESHOLD,
      });
    } else {
      result.telemetry.output_chars = originalOutputChars;
      outputJson = JSON.stringify(result, null, 2);
    }

    return {
      content: [
        {
          type: "text",
          text: outputJson,
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
    
    let diagnosticMessage = `Tool execution failed in package '${package_id}', tool '${tool_id}'.\n`;
    
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
