import { ListToolsInput, ListToolsOutput, ERROR_CODES, ToolInfo } from "../types.js";
import { Catalog } from "../catalog.js";
import { PackageRegistry } from "../registry.js";
import { computeSecurityAnnotation, extractRawToolId } from "./annotateToolSecurity.js";

export async function handleListTools(
  input: ListToolsInput,
  catalog: Catalog,
  _validator: any,
  registry?: PackageRegistry
): Promise<any> {
  const {
    package_id,
    detail,
    summarize = true,
    include_schemas = true,
    page_size = 20,
    page_token,
  } = input;

  // Resolve detail parameter to effective boolean flags
  // detail takes precedence over individual params when provided
  let effectiveSummarize = summarize;
  let effectiveIncludeSchemas = include_schemas;

  if (detail !== undefined) {
    if (detail !== "lite" && detail !== "full") {
      throw {
        code: ERROR_CODES.INVALID_PARAMS,
        message: `Invalid detail value: "${detail}". Must be "lite" or "full".`,
      };
    }
    if (detail === "lite") {
      effectiveSummarize = false;
      effectiveIncludeSchemas = false;
    } else {
      effectiveSummarize = true;
      effectiveIncludeSchemas = true;
    }
  }

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
    summarize: effectiveSummarize,
    include_schemas: effectiveIncludeSchemas,
    include_descriptions: true,
  });

  // Annotate tools with security blocked status
  const catalogId = registry?.getPackage(package_id)?.catalogId;
  const tools: ToolInfo[] = toolInfos.map(tool => ({
    ...tool,
    ...computeSecurityAnnotation(package_id, catalogId, extractRawToolId(tool.tool_id)),
  }));

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
