import { ListToolPackagesInput, ListToolPackagesOutput, PackageConfig } from "../types.js";
import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { coerceStringifiedBoolean, coerceStringifiedNumber } from "../utils/normalizeInput.js";

// Limit concurrent package loading to avoid spawning too many MCP processes at once
const PACKAGE_LOAD_CONCURRENCY = 5;

/**
 * Run async functions with limited concurrency.
 * Processes items in order but limits how many are in-flight simultaneously.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const promise = fn(item).then(result => {
      results[i] = result;
    }).finally(() => {
      executing.delete(promise);
    });
    executing.add(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

export async function handleListToolPackages(
  input: ListToolPackagesInput,
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  let { safe_only = true, limit = 100, include_health = true } = input;

  // Normalize inputs that the model may have stringified (upstream Claude model bug).
  // See: anthropics/claude-code#25865
  safe_only = coerceStringifiedBoolean(safe_only, { handler: "list_tool_packages", field: "safe_only" }) as typeof safe_only;
  limit = coerceStringifiedNumber(limit, { handler: "list_tool_packages", field: "limit" }) as typeof limit;
  include_health = coerceStringifiedBoolean(include_health, {
    handler: "list_tool_packages",
    field: "include_health",
  }) as typeof include_health;

  const packages = registry.getPackages({ safe_only }).slice(0, limit);
  
  // Use concurrency-limited processing to avoid overwhelming the system
  const packageInfos = await mapWithConcurrencyLimit(
    packages,
    async (pkg: PackageConfig) => {
      await catalog.ensurePackageLoaded(pkg.id);

      // Run health check BEFORE reading catalog data so we can sync stale state first
      const health = include_health ? await registry.healthCheck(pkg.id) : undefined;

      // Sync catalog if registry reports healthy but catalog has stale error
      if (health === "ok") {
        const currentStatus = catalog.getPackageStatus(pkg.id);
        if (currentStatus === "error" || currentStatus === "auth_required") {
          catalog.clearPackage(pkg.id);
          await catalog.ensurePackageLoaded(pkg.id);
        }
      }

      const toolCount = catalog.countTools(pkg.id);
      const summary = await catalog.buildPackageSummary(pkg);
      const catalogStatus = catalog.getPackageStatus(pkg.id);
      const catalogError = catalog.getPackageError(pkg.id);

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
        catalog_status: catalogStatus !== "unknown" ? catalogStatus : undefined,
        catalog_error: catalogError,
      };
    },
    PACKAGE_LOAD_CONCURRENCY
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
