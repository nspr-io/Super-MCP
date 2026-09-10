import type { PackageConfig } from "../types.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export interface PackageResolutionRegistry {
  getPackage(packageId: string): PackageConfig | undefined;
  findPackagesByAlias(alias: string): PackageConfig[];
}

export type PackageResolution =
  | { outcome: "exact"; packageId: string }
  | { outcome: "unique_family"; packageId: string }
  | { outcome: "ambiguous"; candidateIds: string[] }
  | { outcome: "not_found" };

/** Resolve configured package identity only. Catalog readiness is deliberately not consulted. */
export function resolvePackageId(
  registry: PackageResolutionRegistry,
  packageId: string,
): PackageResolution {
  const exactMatch = registry.getPackage(packageId);
  if (exactMatch) {
    return { outcome: "exact", packageId };
  }

  const familyMatches = registry.findPackagesByAlias(packageId);
  if (familyMatches.length === 1) {
    const resolvedPackageId = familyMatches[0].id;
    logger.debug("Resolved bare package alias to single instance", {
      original_package_id: packageId,
      resolved_package_id: resolvedPackageId,
    });
    return { outcome: "unique_family", packageId: resolvedPackageId };
  }

  if (familyMatches.length > 1) {
    return {
      outcome: "ambiguous",
      candidateIds: familyMatches.map((candidate) => candidate.id),
    };
  }

  return { outcome: "not_found" };
}

export function formatAmbiguousPackageMessage(
  packageId: string,
  candidateIds: string[],
): string {
  return `Package alias '${packageId}' matches ${candidateIds.length} active accounts. Specify the full package_id (e.g. ${candidateIds.map((candidateId) => `'${candidateId}'`).join(", ")}).`;
}
