import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { UseToolOutput } from "../types.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

function sanitizeForFilename(str: string): string {
  return str.replace(/[\\/:*?"<>|\n\r]/g, '_').replace(/\.\.+/g, '_').slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractDataForMaterialization(toolResult: unknown): { data: unknown, isStringText: boolean, isError: boolean, hasBlob: boolean } {
  let isError = false;
  let hasBlob = false;
  if (isRecord(toolResult)) {
    if (toolResult.isError) isError = true;
    if (Array.isArray(toolResult.content)) {
      hasBlob = toolResult.content.some((block: any) => block.type !== "text");
      if (toolResult.content.length === 1 && isRecord(toolResult.content[0]) && toolResult.content[0].type === "text" && typeof toolResult.content[0].text === "string") {
        return { data: toolResult.content[0].text, isStringText: true, isError, hasBlob };
      }
      return { data: toolResult.content, isStringText: false, isError, hasBlob };
    }
  }
  return { data: toolResult, isStringText: false, isError, hasBlob };
}

export async function materializeOutput(
  package_id: string,
  tool_id: string,
  args_used: unknown,
  toolResult: unknown,
  duration_ms: number,
  workspacePath: string,
  limit: number,
): Promise<UseToolOutput | null> {
  if (!workspacePath) {
    return null;
  }

  const { data, isStringText, hasBlob } = extractDataForMaterialization(toolResult);

  if (hasBlob) {
    return null; // T19: Blob/binary content type -> falls back to continuation
  }

  let isJson = !isStringText;
  let parsedData = data;

  if (isStringText && typeof data === "string") {
    const trimmed = data.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed === "object" && parsed !== null) {
          isJson = true;
          parsedData = parsed;
        }
      } catch (e) {
        // Not valid JSON
      }
    }
  }

  let fileContent = "";
  let ext = ".txt";

  if (isJson) {
    ext = ".json";
    fileContent = JSON.stringify(parsedData, null, 2);
  } else {
    ext = ".txt";
    const frontmatter = `---\npackage_id: ${JSON.stringify(package_id)}\ntool_id: ${JSON.stringify(tool_id)}\n---\n`;
    fileContent = frontmatter + (data as string);
  }

  const size_chars = fileContent.length;

  if (size_chars <= limit) {
    return null; // Not large enough to materialize
  }

  const SIZE_CAP_CHARS = 20_000_000; // 20MB
  if (size_chars > SIZE_CAP_CHARS) {
    logger.warn("Materialization skipped: output exceeds 20MB cap", { package_id, tool_id, size_chars });
    return null; // T18: >20MB falls back to continuation
  }

  // Write file atomically
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const hash = crypto.randomBytes(4).toString('hex');
  const safePackageId = sanitizeForFilename(package_id);
  const safeToolId = sanitizeForFilename(tool_id);
  const filename = `${yy}${mm}${dd}_${HH}${MM}_${safePackageId}_${safeToolId}_${hash}${ext}`;

  const targetDir = path.join(workspacePath, ".rebel", "tool-outputs");
  const filePath = path.join(targetDir, filename);

  // Defense-in-depth: verify resolved path is within the target directory
  const resolvedPath = path.resolve(filePath);
  const resolvedTarget = path.resolve(targetDir);
  if (!resolvedPath.startsWith(resolvedTarget + path.sep) && resolvedPath !== resolvedTarget) {
    logger.error("Path traversal detected, aborting materialization", { package_id, tool_id, filePath });
    return null;
  }

  const tmpFilePath = filePath + ".tmp";

  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(tmpFilePath, fileContent, "utf8");
    await fs.rename(tmpFilePath, filePath);
  } catch (err: any) {
    // Clean up tmp file if possible
    try { await fs.unlink(tmpFilePath); } catch (e) {}
    
    // Log failure
    logger.warn("Materialization failed", {
      event: 'materialization_failed_fallback',
      package_id,
      tool_id,
      size_chars,
      file_path: filePath,
      errno: err.errno,
      error: err.message
    });
    return null; // Fallback to continuation
  }

  logger.info("Materialization successful", {
    event: 'materialization_success',
    package_id,
    tool_id,
    size_chars,
    file_path: filePath
  });

  const preview = fileContent.slice(0, 2048);
  const estimated_tokens = Math.ceil(size_chars / 4);

  const result = {
    status: "materialized",
    message: `Full output (${size_chars.toLocaleString()} chars) saved to file. Use Read/Grep to explore.`,
    file_path: filePath,
    size_chars: size_chars,
    estimated_tokens: estimated_tokens,
    preview: preview,
    preview_truncated: size_chars > 2048
  };

  return {
    package_id,
    tool_id,
    args_used,
    result,
    telemetry: { duration_ms, status: "ok", materialized: true }
  };
}
