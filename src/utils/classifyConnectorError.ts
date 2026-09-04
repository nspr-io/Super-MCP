import type {
  ClientReadinessOutcome,
  PackageConfig,
  PermanentConnectFailureClass,
  TransientConnectFailureClass,
} from "../types.js";

const PERMANENT_ERROR_CODES = new Set(["ENOENT", "EACCES"]);
const MAX_ERROR_CAUSE_NODES = 8;

function errorNodes(error: unknown): unknown[] {
  const pending: unknown[] = [error];
  const result: unknown[] = [];
  const seen = new Set<object>();

  while (pending.length > 0 && result.length < MAX_ERROR_CAUSE_NODES) {
    const current = pending.shift();
    result.push(current);
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const causal = current as { cause?: unknown; originalError?: unknown };
    pending.push(causal.cause, causal.originalError);
  }

  return result;
}

function stringField(node: unknown, field: "code" | "message" | "name"): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isAuthFailure(config: PackageConfig, error: unknown): boolean {
  if (config.transport !== "http") return false;

  return errorNodes(error).some((node) => {
    const name = stringField(node, "name")?.toLowerCase();
    const code = stringField(node, "code")?.toLowerCase();
    const message = typeof node === "string"
      ? node.toLowerCase()
      : stringField(node, "message")?.toLowerCase();
    const status = typeof node === "object" && node !== null
      ? (node as { status?: unknown; statusCode?: unknown }).status ??
        (node as { statusCode?: unknown }).statusCode
      : undefined;

    return name === "unauthorizederror" ||
      code === "invalid_token" ||
      code === "insufficient_scope" ||
      status === 401 ||
      message?.includes("invalid_token") === true ||
      message?.includes("insufficient_scope") === true ||
      /(?:^|\D)401(?:\D|$)/.test(message ?? "");
  });
}

function permanentFailureClass(error: unknown): PermanentConnectFailureClass | undefined {
  for (const node of errorNodes(error)) {
    const code = stringField(node, "code")?.toUpperCase();
    const message = (typeof node === "string" ? node : stringField(node, "message"))?.toLowerCase();
    if (code === "ENOENT" || message?.includes("command not found") || message?.includes("enoent")) {
      return "executable_not_found";
    }
    if (code === "EACCES" || message?.includes("permission denied") || message?.includes("eacces")) {
      return "permission_denied";
    }
    if (code && PERMANENT_ERROR_CODES.has(code)) return "unknown";
  }
  return undefined;
}

export function classifyTransientConnectorError(error: unknown): TransientConnectFailureClass {
  for (const node of errorNodes(error)) {
    const code = stringField(node, "code")?.toUpperCase();
    const message = (typeof node === "string" ? node : stringField(node, "message"))?.toLowerCase();
    if (code === "ETIMEDOUT" || message?.includes("timed out") || message?.includes("timeout")) {
      return "timeout";
    }
    if (code === "ECONNREFUSED" || message?.includes("econnrefused") || message?.includes("connection refused")) {
      return "connection_refused";
    }
    if (code === "ECONNRESET" || message?.includes("econnreset") || message?.includes("connection reset")) {
      return "connection_reset";
    }
  }
  return error instanceof Error ? "transport_error" : "unknown";
}

export function classifyConnectorError(
  config: PackageConfig,
  error: unknown,
): Exclude<ClientReadinessOutcome, { kind: "ready" }> {
  if (isAuthFailure(config, error)) {
    return { kind: "auth_required", error };
  }
  const failureClass = permanentFailureClass(error);
  if (failureClass) {
    return { kind: "permanent_failure", failureClass, error };
  }
  return {
    kind: "transient_failure",
    failureClass: classifyTransientConnectorError(error),
    error,
  };
}
