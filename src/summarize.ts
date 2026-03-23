import { getLogger } from "./logging.js";

const logger = getLogger();

export function summarizeTool(tool: any): string {
  if (tool.description && typeof tool.description === "string") {
    return tool.description.length > 200 
      ? tool.description.substring(0, 197) + "..." 
      : tool.description;
  }

  if (tool.name) {
    return `${tool.name} tool`;
  }

  return "MCP tool";
}

export function argsSkeleton(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return {};
  }

  if (schema.type === "object" && schema.properties) {
    const skeleton: any = {};
    for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
      skeleton[key] = createSkeletonValue(prop, key);
    }
    return skeleton;
  }

  return createSkeletonValue(schema);
}

function createSkeletonValue(schema: any, key?: string): any {
  if (!schema || typeof schema !== "object") {
    return "<unknown>";
  }

  const type = schema.type;

  switch (type) {
    case "string":
      if (schema.format === "uri") return "<url>";
      if (schema.format === "email") return "<email>";
      if (schema.format === "date") return "<date>";
      if (schema.format === "date-time") return "<datetime>";
      if (key?.toLowerCase().includes("path")) return "<path>";
      if (key?.toLowerCase().includes("id")) return "<id>";
      return "<string>";

    case "number":
    case "integer":
      return "<number>";

    case "boolean":
      return "<boolean>";

    case "array":
      if (schema.items) {
        return [createSkeletonValue(schema.items)];
      }
      return ["<item>"];

    case "object":
      if (schema.properties) {
        const obj: any = {};
        for (const [propKey, propSchema] of Object.entries(schema.properties)) {
          obj[propKey] = createSkeletonValue(propSchema, propKey);
        }
        return obj;
      }
      return {};

    default:
      if (schema.enum && Array.isArray(schema.enum)) {
        return schema.enum[0];
      }
      return "<value>";
  }
}

export function summarizePackage(packageConfig: any, tools: any[]): string {
  const toolCount = tools.length;
  
  // Group tools by common patterns to provide better context
  const toolCategories = categorizeTools(tools);
  const categoryList = Object.entries(toolCategories)
    .filter(([_, count]) => count > 0)
    .map(([cat, count]) => `${count} ${cat}`)
    .slice(0, 3)
    .join(", ");

  // Enhanced package descriptions based on package ID patterns
  const packageId = packageConfig.id?.toLowerCase() || "";
  let contextualDescription = "";
  
  if (packageId.includes("filesystem") || packageId.includes("file")) {
    contextualDescription = "File and directory management. ";
  } else if (packageId.includes("github")) {
    contextualDescription = "GitHub repository and issue management. ";
  } else if (packageId.includes("notion")) {
    contextualDescription = "Notion workspace and page management. ";
  } else if (packageId.includes("slack")) {
    contextualDescription = "Slack messaging and workspace tools. ";
  } else if (packageId.includes("search") || packageId.includes("brave")) {
    contextualDescription = "Web search and information retrieval. ";
  } else if (packageId.includes("git")) {
    contextualDescription = "Git version control operations. ";
  } else if (packageId.includes("docker")) {
    contextualDescription = "Docker container management. ";
  } else if (packageId.includes("database") || packageId.includes("sql")) {
    contextualDescription = "Database operations and queries. ";
  }

  const transportInfo = packageConfig.transport === "stdio" 
    ? "Local" 
    : packageConfig.oauth 
      ? "Cloud (OAuth)" 
      : "Remote";

  if (toolCount === 0) {
    return `${transportInfo} MCP. ${contextualDescription}No tools loaded (may require authentication).`;
  }

  return `${transportInfo} MCP with ${toolCount} tools. ${contextualDescription}Capabilities: ${categoryList || toolCategories.general + " general tools"}.`;
}

function categorizeTools(tools: any[]): Record<string, number> {
  const categories = {
    read: 0,
    write: 0,
    search: 0,
    create: 0,
    delete: 0,
    update: 0,
    list: 0,
    auth: 0,
    general: 0,
  };

  for (const tool of tools) {
    const name = tool.name?.toLowerCase() || "";
    const desc = tool.description?.toLowerCase() || "";
    const combined = name + " " + desc;

    if (combined.includes("read") || combined.includes("get") || combined.includes("fetch")) {
      categories.read++;
    } else if (combined.includes("write") || combined.includes("save") || combined.includes("store")) {
      categories.write++;
    } else if (combined.includes("search") || combined.includes("find") || combined.includes("query")) {
      categories.search++;
    } else if (combined.includes("create") || combined.includes("add") || combined.includes("new")) {
      categories.create++;
    } else if (combined.includes("delete") || combined.includes("remove") || combined.includes("destroy")) {
      categories.delete++;
    } else if (combined.includes("update") || combined.includes("edit") || combined.includes("modify")) {
      categories.update++;
    } else if (combined.includes("list") || combined.includes("enumerate") || combined.includes("show")) {
      categories.list++;
    } else if (combined.includes("auth") || combined.includes("login") || combined.includes("token")) {
      categories.auth++;
    } else {
      categories.general++;
    }
  }

  return categories;
}

export function createSchemaHash(schema: any): string {
  if (!schema) return "empty";
  
  // Simple hash function for schema
  const str = JSON.stringify(schema);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `sha256:${Math.abs(hash).toString(16)}`;
}