import { ListToolsInput, ListToolsOutput, ERROR_CODES, ToolInfo } from "../types.js";
import { Catalog } from "../catalog.js";
import { getSecurityPolicy } from "../security.js";

export async function handleListTools(
  input: ListToolsInput,
  catalog: Catalog,
  _validator: any
): Promise<any> {
  const {
    package_id,
    name_pattern,
    summarize = true,
    include_schemas = false,
    page_size = 20,
    page_token,
  } = input;

  await catalog.ensurePackageLoaded(package_id);
  const packageStatus = catalog.getPackageStatus(package_id);
  if (packageStatus === "auth_required") {
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' requires authentication. Run 'authenticate(package_id: "${package_id}")'.`,
      data: { package_id, status: packageStatus },
    };
  }
  if (packageStatus === "error") {
    const reason = catalog.getPackageError(package_id) || "See logs for details";
    throw {
      code: ERROR_CODES.PACKAGE_UNAVAILABLE,
      message: `Package '${package_id}' is unavailable: ${reason}`,
      data: { package_id, status: packageStatus },
    };
  }

  const toolInfos = await catalog.buildToolInfos(package_id, {
    summarize,
    include_schemas,
  });

  // Annotate tools with security blocked status and user-disabled status
  const securityPolicy = getSecurityPolicy();
  const annotatedTools: ToolInfo[] = toolInfos.map(tool => {
    // Extract the raw tool name (without package prefix) for checking
    const rawToolId = tool.tool_id.includes('__') 
      ? tool.tool_id.split('__').slice(1).join('__')
      : tool.tool_id;
    
    // Check security policy first (takes precedence)
    const blockCheck = securityPolicy.isToolBlocked(package_id, rawToolId);
    
    // Check user-disabled status (separate from security policy)
    const isUserDisabled = securityPolicy.isUserDisabled(package_id, rawToolId);
    
    // Security-blocked takes precedence over user-disabled
    if (blockCheck.blocked) {
      return {
        ...tool,
        blocked: true,
        blocked_reason: blockCheck.reason,
        // Do NOT set user_disabled for security-blocked tools
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
  });

  // Apply name_pattern filter if provided
  let tools = annotatedTools;
  if (name_pattern) {
    // Validate pattern
    if (typeof name_pattern !== 'string') {
      throw {
        code: ERROR_CODES.INVALID_PARAMS,
        message: "name_pattern must be a string",
      };
    }
    if (name_pattern.length > 200) {
      throw {
        code: ERROR_CODES.INVALID_PARAMS,
        message: "name_pattern exceeds maximum length of 200 characters",
      };
    }
    
    // Convert glob to regex with anchoring for full-string match
    // 1. Collapse consecutive wildcards to prevent ReDoS
    // 2. Escape special regex chars
    // 3. Convert glob wildcards: * -> .*, ? -> .
    // 4. Anchor for full-string match
    const collapsed = name_pattern.replace(/\*+/g, '*');
    const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`, 'i');
    tools = tools.filter(t => regex.test(t.name) || regex.test(t.tool_id));
  }

  const startIndex = page_token ? 
    Math.max(0, parseInt(Buffer.from(page_token, 'base64').toString('utf8'))) : 0;
  const endIndex = startIndex + page_size;
  const pagedTools = tools.slice(startIndex, endIndex);
  
  const nextToken = endIndex < tools.length ? 
    Buffer.from(endIndex.toString()).toString('base64') : null;

  const result: ListToolsOutput = {
    tools: pagedTools,
    next_page_token: nextToken,
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
