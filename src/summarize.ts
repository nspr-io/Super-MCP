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
  const transportInfo = packageConfig.transport === "stdio"
    ? "Local"
    : packageConfig.oauth
      ? "Cloud (OAuth)"
      : "Remote";

  if (toolCount === 0) {
    return `${transportInfo} MCP package (no tools loaded).`;
  }

  const desc = packageConfig.description
    ? ` ${packageConfig.description}`
    : '';
  return `${transportInfo} MCP with ${toolCount} tools.${desc}`;
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