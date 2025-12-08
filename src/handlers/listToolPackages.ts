import { ListToolPackagesInput, ListToolPackagesOutput } from "../types.js";
import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";

export async function handleListToolPackages(
  input: ListToolPackagesInput,
  registry: PackageRegistry,
  catalog: Catalog
): Promise<any> {
  const { safe_only = true, limit = 100, include_health = true } = input;

  const packages = registry.getPackages({ safe_only }).slice(0, limit);
  
  const packageInfos = await Promise.all(
    packages.map(async (pkg) => {
      await catalog.ensurePackageLoaded(pkg.id);
      const toolCount = catalog.countTools(pkg.id);
      const health = include_health ? await registry.healthCheck(pkg.id) : undefined;
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
