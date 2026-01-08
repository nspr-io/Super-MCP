import { PackageRegistry } from "../registry.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export interface HealthCheckPackageOutput {
  package_id: string;
  health: "ok" | "error" | "unavailable";
}

export async function handleHealthCheckPackage(
  input: { package_id: string },
  registry: PackageRegistry
): Promise<any> {
  const { package_id } = input;

  if (!package_id || typeof package_id !== "string") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            package_id: package_id ?? "",
            health: "unavailable",
            error: "package_id is required and must be a non-empty string"
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  logger.info("Handling health_check request", { package_id });

  const health = await registry.healthCheck(package_id);

  const result: HealthCheckPackageOutput = {
    package_id,
    health,
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
