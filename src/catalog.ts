import { ToolInfo, PackageConfig } from "./types.js";
import { PackageRegistry } from "./registry.js";
import { summarizeTool, argsSkeleton, summarizePackage, createSchemaHash } from "./summarize.js";
import { getLogger } from "./logging.js";

const logger = getLogger();
const ERROR_RETRY_INTERVAL_MS = 60_000;
type CatalogStatus = "ready" | "auth_required" | "error";

interface CachedTool {
  packageId: string;
  tool: any;
  summary?: string;
  argsSkeleton?: any;
  schemaHash: string;
}

interface PackageToolCache {
  packageId: string;
  tools: CachedTool[];
  lastUpdated: number;
  etag: string;
  status: CatalogStatus;
  lastError?: string;
}

export class Catalog {
  private cache: Map<string, PackageToolCache> = new Map();
  private registry: PackageRegistry;
  private globalEtag: string = "";
  private resourceUriToPackage: Map<string, string> = new Map();

  constructor(registry: PackageRegistry) {
    this.registry = registry;
    this.updateGlobalEtag();
  }

  private updateGlobalEtag(): void {
    const timestamp = Date.now().toString();
    const cacheKeys = Array.from(this.cache.keys()).sort().join(",");
    this.globalEtag = `sha256:${Buffer.from(timestamp + cacheKeys).toString('hex').slice(0, 16)}`;
  }

  async refreshPackage(packageId: string): Promise<void> {
    logger.debug("Refreshing package catalog", { package_id: packageId });

    try {
      const client = await this.registry.getClient(packageId);
      const tools = await client.listTools();

      const cachedTools: CachedTool[] = tools.map(tool => ({
        packageId,
        tool,
        summary: summarizeTool(tool),
        argsSkeleton: argsSkeleton(tool.inputSchema),
        schemaHash: createSchemaHash(tool.inputSchema),
      }));

      const packageEtag = `sha256:${Buffer.from(JSON.stringify(cachedTools)).toString('hex').slice(0, 16)}`;

      this.cache.set(packageId, {
        packageId,
        tools: cachedTools,
        lastUpdated: Date.now(),
        etag: packageEtag,
        status: "ready",
        lastError: undefined,
      });

      this.updateGlobalEtag();

      logger.debug("Package catalog refreshed", {
        package_id: packageId,
        tool_count: tools.length,
        etag: packageEtag,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to refresh package catalog", {
        package_id: packageId,
        error: message,
      });

      const { status, etag, lastError } = this.categorizeError(packageId, error);

      this.cache.set(packageId, {
        packageId,
        tools: [],
        lastUpdated: Date.now(),
        etag,
        status,
        lastError,
      });

      this.updateGlobalEtag();
    }
  }

  async ensurePackageLoaded(packageId: string): Promise<void> {
    const cached = this.cache.get(packageId);
    if (!cached) {
      await this.refreshPackage(packageId);
      return;
    }

    const needsRetry =
      cached.status !== "ready" && Date.now() - cached.lastUpdated > ERROR_RETRY_INTERVAL_MS;

    if (needsRetry) {
      await this.refreshPackage(packageId);
    }
  }

  async getPackageTools(packageId: string): Promise<CachedTool[]> {
    await this.ensurePackageLoaded(packageId);
    const cached = this.cache.get(packageId);
    return cached?.tools || [];
  }

  countTools(packageId: string): number {
    const cached = this.cache.get(packageId);
    return cached?.tools.length || 0;
  }

  async getTool(packageId: string, toolId: string): Promise<CachedTool | undefined> {
    await this.ensurePackageLoaded(packageId);
    const cached = this.cache.get(packageId);
    return cached?.tools.find(t => t.tool.name === toolId);
  }

  async getToolSchema(packageId: string, toolId: string): Promise<any> {
    const tool = await this.getTool(packageId, toolId);
    return tool?.tool.inputSchema;
  }

  paginate(
    packageId: string,
    pageSize: number = 20,
    pageToken?: string | null
  ): { items: CachedTool[]; next: string | null } {
    const cached = this.cache.get(packageId);
    if (!cached) {
      return { items: [], next: null };
    }

    const tools = cached.tools;
    let startIndex = 0;

    if (pageToken) {
      try {
        const decoded = Buffer.from(pageToken, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        startIndex = parsed.index || 0;
      } catch (error) {
        logger.warn("Invalid page token", {
          package_id: packageId,
          page_token: pageToken,
        });
        startIndex = 0;
      }
    }

    const endIndex = startIndex + pageSize;
    const items = tools.slice(startIndex, endIndex);
    
    let nextToken: string | null = null;
    if (endIndex < tools.length) {
      nextToken = Buffer.from(JSON.stringify({ index: endIndex })).toString('base64');
    }

    return { items, next: nextToken };
  }

  etag(): string {
    return this.globalEtag;
  }

  getPackageEtag(packageId: string): string {
    const cached = this.cache.get(packageId);
    return cached?.etag || "";
  }

  async buildPackageSummary(packageConfig: PackageConfig): Promise<string> {
    try {
      const tools = await this.getPackageTools(packageConfig.id);
      
      // If no tools loaded (e.g., needs auth), return a descriptive message
      if (tools.length === 0) {
        const cached = this.cache.get(packageConfig.id);
        if (cached?.status === "auth_required") {
          return `${packageConfig.transport} MCP package (authentication required)`;
        }
        if (cached?.status === "error") {
          const reason = cached.lastError ? `: ${cached.lastError}` : "";
          return `${packageConfig.transport} MCP package (unavailable${reason})`;
        }
        return `${packageConfig.transport} MCP package (no tools available)`;
      }
      
      const toolsForSummary = tools.map(ct => ct.tool);
      return summarizePackage(packageConfig, toolsForSummary);
    } catch (error) {
      logger.debug("Failed to build package summary", {
        package_id: packageConfig.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return `${packageConfig.transport} MCP package`;
    }
  }

  async buildToolInfos(
    packageId: string,
    options: {
      summarize?: boolean;
      include_schemas?: boolean;
      include_descriptions?: boolean;
    } = {}
  ): Promise<ToolInfo[]> {
    const tools = await this.getPackageTools(packageId);

    return tools.map(cachedTool => {
      // Add namespace prefix to ensure global uniqueness across all packages
      // This prevents tool name collisions when multiple packages have identically named tools
      const namespacedId = `${packageId}__${cachedTool.tool.name}`;

      return {
        package_id: packageId,
        tool_id: namespacedId,
        name: namespacedId,
        description: options.include_descriptions ? cachedTool.tool.description : undefined,
        summary: options.summarize ? cachedTool.summary : undefined,
        args_skeleton: options.summarize ? cachedTool.argsSkeleton : undefined,
        schema_hash: cachedTool.schemaHash,
        schema: options.include_schemas ? cachedTool.tool.inputSchema : undefined,
      };
    });
  }

  clear(): void {
    logger.debug("Clearing catalog cache");
    this.cache.clear();
    this.updateGlobalEtag();
  }

  clearPackage(packageId: string): void {
    logger.debug("Clearing package cache", { package_id: packageId });
    this.cache.delete(packageId);
    this.updateGlobalEtag();
  }

  getPackageStatus(packageId: string): CatalogStatus | "unknown" {
    const cached = this.cache.get(packageId);
    return cached?.status ?? "unknown";
  }

  getPackageError(packageId: string): string | undefined {
    return this.cache.get(packageId)?.lastError;
  }

  getCacheStats(): { packageCount: number; totalTools: number } {
    let totalTools = 0;
    for (const cached of this.cache.values()) {
      totalTools += cached.tools.length;
    }

    return {
      packageCount: this.cache.size,
      totalTools,
    };
  }

  private categorizeError(packageId: string, error: unknown): {
    status: CatalogStatus;
    etag: string;
    lastError?: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    if (this.isAuthError(error)) {
      logger.info("Package requires authentication, caching empty tools", {
        package_id: packageId,
      });
      return {
        status: "auth_required",
        etag: `auth-pending-${Date.now()}`,
      };
    }

    return {
      status: "error",
      etag: `error-${Date.now()}`,
      lastError: message,
    };
  }

  private isAuthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      error.name === "UnauthorizedError" ||
      message.includes("oauth") ||
      message.includes("401") ||
      message.includes("unauthorized") ||
      message.includes("invalid_token") ||
      message.includes("authorization")
    );
  }

  // Resource URI mapping for MCP Apps support

  /**
   * Register resource URIs from tool metadata.
   * Called when loading tools for a package to build the uri -> package mapping.
   */
  registerResourceUris(packageId: string, tools: any[]): void {
    for (const tool of tools) {
      const resourceUri = tool._meta?.ui?.resourceUri;
      if (resourceUri && typeof resourceUri === "string") {
        const prefix = this.extractUriPrefix(resourceUri);
        if (prefix) {
          this.resourceUriToPackage.set(prefix, packageId);
          logger.debug("Registered resource URI prefix", {
            package_id: packageId,
            prefix,
            full_uri: resourceUri,
          });
        }
      }
    }
  }

  /**
   * Look up which package owns a resource URI.
   * Returns the package ID if found in the mapping, undefined otherwise.
   */
  getPackageForResourceUri(uri: string): string | undefined {
    const prefix = this.extractUriPrefix(uri);
    if (!prefix) return undefined;
    
    const packageId = this.resourceUriToPackage.get(prefix);
    if (packageId) {
      logger.debug("Found package for resource URI", {
        uri,
        prefix,
        package_id: packageId,
      });
    }
    return packageId;
  }

  /**
   * Get all known resource URI prefixes for error messages.
   */
  getKnownResourcePrefixes(): string[] {
    return Array.from(this.resourceUriToPackage.keys());
  }

  /**
   * Clear resource URI mappings for a specific package.
   * Called when a package is restarted or removed.
   */
  clearResourceUrisForPackage(packageId: string): void {
    for (const [prefix, pkgId] of this.resourceUriToPackage.entries()) {
      if (pkgId === packageId) {
        this.resourceUriToPackage.delete(prefix);
        logger.debug("Cleared resource URI prefix", { package_id: packageId, prefix });
      }
    }
  }

  /**
   * Extract the URI prefix (scheme + authority) from a resource URI.
   * e.g., "ui://viewer/app.html" -> "ui://viewer"
   */
  private extractUriPrefix(uri: string): string | null {
    try {
      // Handle ui:// scheme URIs
      const match = uri.match(/^(ui:\/\/[^/]+)/);
      if (match) {
        return match[1];
      }
      // Handle other schemes (file://, etc.)
      const url = new URL(uri);
      return `${url.protocol}//${url.host}`;
    } catch {
      // Invalid URI
      return null;
    }
  }
}