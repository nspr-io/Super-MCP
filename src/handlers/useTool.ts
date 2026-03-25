import { UseToolInput, UseToolOutput, ERROR_CODES } from "../types.js";
import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import type { ValidationResult } from "../validator.js";
import { McpError, ErrorCode as SdkErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "../logging.js";
import { getSecurityPolicy } from "../security.js";
import { findBestMatch } from "../utils/fuzzyMatch.js";

const logger = getLogger();
const LARGE_OUTPUT_WARNING_THRESHOLD = 150_000;
const MAX_SCHEMA_FRAGMENTS = 5;
const FULL_SCHEMA_FRAGMENT_KEY = "__full_schema";
const STOP_RETRYING_MESSAGE = "Arguments may require user clarification. Please ask the user for specifics.";
const MAX_ATTEMPT_MAP_SIZE = 500;
const validationAttemptMap = new Map<string, number>();

interface RepairTicket {
  missing_required: string[];
  type_errors: Array<{ field: string; expected: string; got: string; value?: unknown }>;
  enum_violations: Array<{ field: string; allowed: unknown[]; got: unknown }>;
  format_errors: Array<{ field: string; expected: string; got: unknown }>;
  unknown_fields: string[];
  did_you_mean: Record<string, string>;
  schema_fragments: Record<string, unknown>;
  valid_fields: string[];
  attempt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getValidationAttemptKey(packageId: string, toolId: string): string {
  return `${packageId}::${toolId}`;
}

function incrementValidationAttempt(key: string): number {
  if (validationAttemptMap.size >= MAX_ATTEMPT_MAP_SIZE) {
    validationAttemptMap.clear();
  }
  const attempt = (validationAttemptMap.get(key) ?? 0) + 1;
  validationAttemptMap.set(key, attempt);
  return attempt;
}

function resetValidationAttempt(key: string): void {
  validationAttemptMap.delete(key);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseInstancePath(instancePath: string | undefined): string[] {
  if (!instancePath) {
    return [];
  }

  return instancePath
    .split("/")
    .filter(Boolean)
    .map(decodeJsonPointerSegment);
}

function formatFieldPath(segments: string[]): string {
  return segments.length > 0 ? segments.join(".") : "root";
}

function getFieldFromValidationError(validationError: any): string {
  return formatFieldPath(parseInstancePath(validationError.instancePath));
}

function getRequiredFieldFromValidationError(validationError: any): string {
  const segments = parseInstancePath(validationError.instancePath);
  const missingProperty = validationError?.params?.missingProperty;
  if (typeof missingProperty === "string" && missingProperty.length > 0) {
    segments.push(missingProperty);
  }
  return formatFieldPath(segments);
}

function getTopLevelField(fieldPath: string): string | null {
  if (!fieldPath || fieldPath === "root") {
    return null;
  }
  return fieldPath.split(".")[0] || null;
}

function getValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function buildSchemaFragments(
  schema: unknown,
  failingFields: Set<string>,
  includeFullSchema: boolean,
): Record<string, unknown> {
  if (!isRecord(schema)) {
    return {};
  }

  if (includeFullSchema) {
    return {
      [FULL_SCHEMA_FRAGMENT_KEY]: schema,
    };
  }

  const schemaProperties = isRecord(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  const fragments: Record<string, unknown> = {};

  for (const field of failingFields) {
    if (Object.keys(fragments).length >= MAX_SCHEMA_FRAGMENTS) {
      break;
    }

    const topLevelField = getTopLevelField(field);
    if (!topLevelField || fragments[topLevelField] !== undefined) {
      continue;
    }

    const fragment = schemaProperties[topLevelField];
    if (fragment !== undefined) {
      fragments[topLevelField] = fragment;
    }
  }

  return fragments;
}

function summarizeRepairTicket(
  packageId: string,
  toolId: string,
  ticket: RepairTicket,
  includeStopRetryingGuidance: boolean,
): string {
  const sections: string[] = [];

  if (ticket.missing_required.length > 0) {
    sections.push(`Missing required: ${ticket.missing_required.join(", ")}.`);
  }

  if (ticket.type_errors.length > 0) {
    const details = ticket.type_errors
      .map((entry) => `${entry.field} (expected ${entry.expected}, got ${entry.got})`)
      .join("; ");
    sections.push(`Type errors: ${details}.`);
  }

  if (ticket.enum_violations.length > 0) {
    const details = ticket.enum_violations
      .map((entry) => `${entry.field} (allowed ${entry.allowed.map(String).join(", ")}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Enum violations: ${details}.`);
  }

  if (ticket.format_errors.length > 0) {
    const details = ticket.format_errors
      .map((entry) => `${entry.field} (expected ${entry.expected}, got ${String(entry.got)})`)
      .join("; ");
    sections.push(`Format errors: ${details}.`);
  }

  if (ticket.unknown_fields.length > 0) {
    const details = ticket.unknown_fields
      .map((field) => {
        const suggestion = ticket.did_you_mean[field];
        return suggestion ? `${field} (did you mean: ${suggestion}?)` : field;
      })
      .join(", ");
    sections.push(`Unknown fields: ${details}.`);

    if (ticket.valid_fields.length > 0) {
      sections.push(`Valid arguments: ${ticket.valid_fields.join(", ")}.`);
    } else {
      sections.push(`This tool takes no arguments. Call it with an empty object: {}.`);
    }
  }

  let message = `Argument validation failed for tool '${toolId}' in package '${packageId}'.`;
  if (sections.length > 0) {
    message += ` ${sections.join(" ")}`;
  }
  if (includeStopRetryingGuidance) {
    message += ` ${STOP_RETRYING_MESSAGE}`;
  }
  return message;
}

function buildRepairTicket(
  schema: unknown,
  validationErrors: any[],
  strippedArgs: string[],
  attempt: number,
): RepairTicket {
  const missingRequired: string[] = [];
  const typeErrors: Array<{ field: string; expected: string; got: string; value?: unknown }> = [];
  const enumViolations: Array<{ field: string; allowed: unknown[]; got: unknown }> = [];
  const formatErrors: Array<{ field: string; expected: string; got: unknown }> = [];
  const failingFields = new Set<string>();
  const validFields = isRecord(schema) && isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  const didYouMean: Record<string, string> = {};

  for (const validationError of validationErrors) {
    if (!validationError || typeof validationError !== "object") {
      continue;
    }

    if (validationError.keyword === "required") {
      const field = getRequiredFieldFromValidationError(validationError);
      missingRequired.push(field);
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "type") {
      const field = getFieldFromValidationError(validationError);
      const expected = Array.isArray(validationError.params?.type)
        ? validationError.params.type.join("|")
        : String(validationError.params?.type ?? "unknown");
      const got = getValueType(validationError.data);
      const typeError: { field: string; expected: string; got: string; value?: unknown } = {
        field,
        expected,
        got,
      };
      if (validationError.data !== undefined) {
        typeError.value = validationError.data;
      }
      typeErrors.push(typeError);
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "enum") {
      const field = getFieldFromValidationError(validationError);
      const allowed = Array.isArray(validationError.params?.allowedValues)
        ? validationError.params.allowedValues
        : [];
      enumViolations.push({
        field,
        allowed,
        got: validationError.data,
      });
      failingFields.add(field);
      continue;
    }

    if (validationError.keyword === "format") {
      const field = getFieldFromValidationError(validationError);
      formatErrors.push({
        field,
        expected: String(validationError.params?.format ?? "unknown"),
        got: validationError.data,
      });
      failingFields.add(field);
    }
  }

  for (const unknownField of strippedArgs) {
    const suggestion = findBestMatch(unknownField, validFields);
    if (suggestion) {
      didYouMean[unknownField] = suggestion;
      failingFields.add(suggestion);
    }
  }

  const includeFullSchema = attempt >= 2;

  return {
    missing_required: missingRequired,
    type_errors: typeErrors,
    enum_violations: enumViolations,
    format_errors: formatErrors,
    unknown_fields: strippedArgs,
    did_you_mean: didYouMean,
    schema_fragments: buildSchemaFragments(schema, failingFields, includeFullSchema),
    valid_fields: validFields,
    attempt,
  };
}

export async function handleUseTool(
  input: UseToolInput & { _rebel_staged?: boolean; _rebel_staged_message?: string },
  registry: PackageRegistry,
  catalog: Catalog,
  validator: { validate: (schema: any, data: any, context?: { package_id?: string; tool_id?: string }) => ValidationResult }
): Promise<any> {
  // Staged tool calls: the host process (toolSafetyService PreToolUse hook) intercepted
  // this call for deferred user approval. It sets _rebel_staged via updatedInput so the
  // SDK treats the call as "allowed" (preventing sibling-error cascade for parallel calls)
  // while we return immediately without executing the underlying tool.
  // See: src/main/services/toolSafetyService.ts — staging path.
  if (input._rebel_staged) {
    return {
      content: [{ type: "text", text: input._rebel_staged_message ?? "Tool call staged for approval." }],
    };
  }

  // Strip rebel-internal flags so they never leak to downstream tool handlers
  const { _rebel_staged, _rebel_staged_message, ...cleanInput } = input;

  let { package_id, tool_id, args, dry_run = false, max_output_chars } = cleanInput;

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

  // Check if tool is disabled by admin (takes precedence over user preference)
  const packageConfig = registry.getPackage(package_id);
  const catalogId = packageConfig?.catalogId;
  if (securityPolicy.isAdminDisabled(catalogId, tool_id)) {
    logger.warn("Blocked attempt to use admin-disabled tool", {
      package_id,
      tool_id,
      catalog_id: catalogId,
    });
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: `Tool '${package_id}__${tool_id}' is disabled by your organization's administrator`,
      data: { package_id, tool_id, blocked_reason: "Disabled by administrator", admin_disabled: true },
    };
  }

  // Check if tool is disabled by user preference (separate from security policy)
  if (securityPolicy.isUserDisabled(package_id, tool_id)) {
    logger.warn("Blocked attempt to use user-disabled tool", {
      package_id,
      tool_id,
    });
    throw {
      code: ERROR_CODES.TOOL_BLOCKED,
      message: `Tool '${package_id}__${tool_id}' is disabled by user preference. Re-enable it in Settings to use.`,
      data: { package_id, tool_id, blocked_reason: "Disabled by user", user_disabled: true },
    };
  }
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
  const validationAttemptKey = getValidationAttemptKey(package_id, tool_id);
  const validationResult = validator.validate(schema, args, { package_id, tool_id });
  const strippedArgs = validationResult.strippedArgs;

  if (!validationResult.valid || strippedArgs.length > 0) {
    const attempt = incrementValidationAttempt(validationAttemptKey);
    const repairTicket = buildRepairTicket(schema, validationResult.errors, strippedArgs, attempt);
    const shouldStopRetrying = attempt >= 3;

    throw {
      code: ERROR_CODES.ARG_VALIDATION_FAILED,
      message: summarizeRepairTicket(package_id, tool_id, repairTicket, shouldStopRetrying),
      data: {
        package_id,
        tool_id,
        errors: validationResult.errors,
        provided_args: args ? Object.keys(args) : [],
        repair_ticket: repairTicket,
      },
    };
  }

  resetValidationAttempt(validationAttemptKey);

  if (dry_run) {
    const result: UseToolOutput = {
      package_id,
      tool_id,
      args_used: args,
      result: { dry_run: true },
      telemetry: { duration_ms: 0, status: "ok" },
    };

    let dryRunJson = JSON.stringify(result, null, 2);

    return {
      content: [
        {
          type: "text",
          text: dryRunJson,
        },
      ],
      isError: false,
    };
  }

  const startTime = Date.now();
  try {
    const client = await registry.getClient(package_id);
    const toolResult = await client.callTool(tool_id, args);
    registry.notifyActivity(package_id);
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
    registry.notifyActivity(package_id);
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
      diagnosticMessage += `\n  3. If authenticate() says 'already_authenticated' but tools still fail, use 'authenticate(package_id: "${package_id}", force: true)' to force re-authentication`;
      diagnosticMessage += `\n  4. Verify credentials have required permissions`;
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
