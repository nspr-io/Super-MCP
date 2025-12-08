import { PackageRegistry } from "../registry.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export async function handleHealthCheckAll(
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
