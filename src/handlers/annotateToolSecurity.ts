import { ToolInfo } from "../types.js";
import { PackageRegistry } from "../registry.js";
import { getSecurityPolicy } from "../security.js";

/**
 * Annotate a ToolInfo with security blocked status, admin-disabled, and user-disabled status.
 * Shared between handleListTools and handleGetToolDetails.
 *
 * Precedence: security-blocked > admin-disabled > user-disabled.
 */
export function annotateToolSecurity(
  tool: ToolInfo,
  packageId: string,
  registry: PackageRegistry
): ToolInfo {
  const securityPolicy = getSecurityPolicy();
  const packageConfig = registry.getPackage(packageId);
  const catalogId = packageConfig?.catalogId;

  // Extract the raw tool name (without package prefix) for checking
  const rawToolId = tool.tool_id.includes('__')
    ? tool.tool_id.slice(tool.tool_id.indexOf('__') + 2)
    : tool.tool_id;

  // Check security policy first (takes precedence)
  const blockCheck = securityPolicy.isToolBlocked(packageId, rawToolId);

  // Check admin-disabled status (takes precedence over user-disabled)
  const isAdminDisabled = securityPolicy.isAdminDisabled(catalogId, rawToolId);

  // Check user-disabled status (separate from security policy)
  const isUserDisabled = securityPolicy.isUserDisabled(packageId, rawToolId);

  // Security-blocked takes highest precedence
  if (blockCheck.blocked) {
    return {
      ...tool,
      blocked: true,
      blocked_reason: blockCheck.reason,
      // Do NOT set user_disabled or admin_disabled for security-blocked tools
    };
  }

  // Admin-disabled takes precedence over user-disabled
  if (isAdminDisabled) {
    return {
      ...tool,
      blocked: true,
      blocked_reason: "Disabled by your organization's administrator",
      admin_disabled: true,
    };
  }

  // User-disabled: set both blocked and user_disabled
  if (isUserDisabled) {
    return {
      ...tool,
      blocked: true,
      blocked_reason: "Disabled by user",
      user_disabled: true,
    };
  }

  return tool;
}
