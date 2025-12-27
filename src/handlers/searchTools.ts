import { ERROR_CODES, ToolInfo } from "../types.js";
import { Catalog } from "../catalog.js";
import { PackageRegistry } from "../registry.js";
import { getSecurityPolicy } from "../security.js";
import { getLogger } from "../logging.js";
// @ts-expect-error - wink-bm25-text-search doesn't have type definitions
import bm25Constructor from "wink-bm25-text-search";

const logger = getLogger();

interface BM25Engine {
  defineConfig: (config: { fldWeights: Record<string, number> }) => void;
  definePrepTasks: (tasks: Array<(text: string) => string[]>) => void;
  addDoc: (doc: Record<string, string>, id: string) => void;
  consolidate: () => void;
  search: (query: string, limit?: number) => Array<[string, number]>;
  reset: () => void;
}

export interface SearchToolsInput {
  query: string;
  limit?: number;
  threshold?: number;
  packages?: string[];
}

export interface SearchToolsOutput {
  results: Array<ToolInfo & { relevance_score: number }>;
  query: string;
  total_tools_searched: number;
}

// Cache for BM25 engine - rebuilt when catalog changes
let cachedBM25Engine: BM25Engine | null = null;
let cachedEtag: string = "";
let cachedToolMap: Map<string, ToolInfo> = new Map();

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/_/g, " ") // Split underscores into spaces for tool names
    .split(/\W+/)
    .filter((token) => token.length > 1);
}

async function buildBM25Index(
  registry: PackageRegistry,
  catalog: Catalog
): Promise<{ engine: BM25Engine; toolMap: Map<string, ToolInfo> }> {
  const currentEtag = catalog.etag();

  // Return cached if etag matches
  if (cachedBM25Engine && cachedEtag === currentEtag) {
    return { engine: cachedBM25Engine, toolMap: cachedToolMap };
  }

  logger.debug("Building BM25 search index", { etag: currentEtag });
  const startTime = Date.now();

  const engine = (bm25Constructor as () => BM25Engine)();
  engine.defineConfig({ fldWeights: { content: 1 } });
  engine.definePrepTasks([tokenize]);

  const toolMap = new Map<string, ToolInfo>();

  for (const pkg of registry.getPackages()) {
    try {
      await catalog.ensurePackageLoaded(pkg.id);
      const tools = await catalog.buildToolInfos(pkg.id, {
        summarize: true,
        include_schemas: true,
      });

      for (const tool of tools) {
        // Build searchable content from name, summary, and parameter names
        const paramNames = tool.schema?.properties
          ? Object.keys(tool.schema.properties).join(" ")
          : "";
        const content = `${tool.name} ${tool.summary || ""} ${paramNames}`;

        engine.addDoc({ content }, tool.tool_id);
        toolMap.set(tool.tool_id, {
          ...tool,
          package_id: pkg.id,
        });
      }
    } catch (error) {
      logger.debug("Skipping package for search index", {
        package_id: pkg.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  engine.consolidate();

  // Update cache
  cachedBM25Engine = engine;
  cachedEtag = currentEtag;
  cachedToolMap = toolMap;

  logger.debug("BM25 search index built", {
    tool_count: toolMap.size,
    elapsed_ms: Date.now() - startTime,
  });

  return { engine, toolMap };
}

export async function handleSearchTools(
  input: SearchToolsInput,
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  const { query, limit = 5, threshold = 0.0, packages } = input;

  if (!query || query.trim().length === 0) {
    throw {
      code: ERROR_CODES.INVALID_PARAMS,
      message: "Query parameter is required and cannot be empty",
    };
  }

  const { engine, toolMap } = await buildBM25Index(registry, catalog);

  // Search with BM25
  const searchResults = engine.search(query, Math.min(limit * 2, 50));

  // Get security policy for blocking check
  const securityPolicy = getSecurityPolicy();

  // Build results with relevance scores
  const results: Array<ToolInfo & { relevance_score: number }> = [];
  let maxScore = 0;

  // First pass to find max score for normalization
  for (const [, score] of searchResults) {
    if (score > maxScore) maxScore = score;
  }

  for (const [toolId, rawScore] of searchResults) {
    const tool = toolMap.get(toolId);
    if (!tool) continue;

    // Filter by package if specified
    if (packages && packages.length > 0) {
      if (!packages.includes(tool.package_id!)) continue;
    }

    // Normalize score to 0-1 range
    const normalizedScore = maxScore > 0 ? rawScore / maxScore : 0;
    if (normalizedScore < threshold) continue;

    // Check if tool is blocked
    const rawToolId = toolId.includes("__")
      ? toolId.split("__").slice(1).join("__")
      : toolId;
    const blockCheck = securityPolicy.isToolBlocked(tool.package_id!, rawToolId);

    results.push({
      ...tool,
      relevance_score: Math.round(normalizedScore * 100) / 100,
      blocked: blockCheck.blocked,
      blocked_reason: blockCheck.blocked ? blockCheck.reason : undefined,
    });

    if (results.length >= limit) break;
  }

  const output: SearchToolsOutput = {
    results,
    query,
    total_tools_searched: toolMap.size,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(output, null, 2),
      },
    ],
    isError: false,
  };
}

// Export function to invalidate cache (called when config changes)
export function invalidateSearchCache(): void {
  cachedBM25Engine = null;
  cachedEtag = "";
  cachedToolMap.clear();
  logger.debug("Search cache invalidated");
}
