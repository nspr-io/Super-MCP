/**
 * Input normalization for Super-MCP meta-tool handlers.
 *
 * Defends against a known upstream Claude model bug where tool arguments are
 * serialized as JSON strings instead of native objects/arrays/booleans.
 * See: anthropics/claude-code#25865, docs/investigations/260330_slow_turn_brute_force_search.md
 *
 * Every coercion is logged so the upstream issue remains visible.
 */

import { getLogger } from "../logging.js";

const logger = getLogger();

/**
 * If `value` is a JSON string whose parsed result matches `expectedType`,
 * return the parsed value. Otherwise return the original value unchanged.
 *
 * Logs every successful coercion at warn level for upstream-bug visibility.
 */
export function coerceStringifiedJson<T>(
  value: unknown,
  expectedType: "object" | "array",
  context: { handler: string; field: string; package_id?: string; tool_id?: string },
): T | unknown {
  if (typeof value !== "string") return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }

  if (expectedType === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    logger.warn("Coerced stringified JSON to object (upstream model bug)", {
      handler: context.handler,
      field: context.field,
      package_id: context.package_id,
      tool_id: context.tool_id,
    });
    return parsed as T;
  }

  if (expectedType === "array" && Array.isArray(parsed)) {
    logger.warn("Coerced stringified JSON to array (upstream model bug)", {
      handler: context.handler,
      field: context.field,
    });
    return parsed as T;
  }

  return value;
}

/**
 * Coerce string "true"/"false" to boolean. Returns the original value
 * if it's already a boolean or not a recognized string.
 */
export function coerceStringifiedBoolean(
  value: unknown,
  context: { handler: string; field: string },
): boolean | unknown {
  if (typeof value === "boolean") return value;
  if (value === "true") {
    logger.warn("Coerced string 'true' to boolean (upstream model bug)", context);
    return true;
  }
  if (value === "false") {
    logger.warn("Coerced string 'false' to boolean (upstream model bug)", context);
    return false;
  }
  return value;
}

/**
 * Coerce numeric strings to numbers. Returns the original value if it's already
 * a number, not a string, empty/whitespace-only, or does not parse to a finite
 * number.
 */
export function coerceStringifiedNumber(
  value: unknown,
  context: { handler: string; field: string },
): number | unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  if (value.trim() === "") return value;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;

  logger.warn("Coerced stringified number (upstream model bug)", context);
  return parsed;
}
