import { PackageRegistry } from "../registry.js";
import { Catalog } from "../catalog.js";
import { getLogger } from "../logging.js";

const logger = getLogger();

export async function handleGetHelp(
  input: { topic?: string; package_id?: string; error_code?: number },
  registry: PackageRegistry
): Promise<any> {
  const { topic = "getting_started", package_id, error_code } = input;

  let helpContent = "";

  if (error_code !== undefined) {
    helpContent = getErrorHelp(error_code);
  }
  else if (package_id) {
    helpContent = await getPackageHelp(package_id, registry);
  }
  else {
    helpContent = getTopicHelp(topic);
  }

  return {
    content: [
      {
        type: "text",
        text: helpContent,
      },
    ],
    isError: false,
  };
}

export function getTopicHelp(topic: string): string {
  const helpTopics: Record<string, string> = {
    getting_started: `# Getting Started with Super-MCP

Super-MCP provides a unified interface to multiple MCP (Model Context Protocol) packages. Here's how to use it effectively:

## Basic Workflow
1. **Discover Packages**: Use \`list_tool_packages\` to see available MCP packages
2. **Explore Tools**: Use \`list_tools\` with a package_id to discover tools in that package
3. **Execute Tools**: Use \`use_tool\` to run a specific tool with appropriate arguments

## Example Flow
\`\`\`
1. list_tool_packages() → See all available packages
2. list_tools(package_id: "filesystem") → See filesystem tools
3. use_tool(package_id: "filesystem", tool_id: "read_file", args: {path: "/tmp/test.txt"})
\`\`\`

## Tips
- Always check package health with \`health_check_all\` if tools aren't working
- Some packages require authentication - use \`authenticate\` when needed
- Use \`dry_run: true\` in use_tool to validate arguments without executing`,

    workflow: `# Super-MCP Workflow Patterns

## Discovery Flow
1. Start with \`list_tool_packages\` to understand available capabilities
2. Note the package_id values for packages you want to use
3. Use \`list_tools\` to explore each package's functionality
4. Review the argument schemas carefully before using tools

## Common Patterns

### File Operations
- Package: usually "filesystem" or similar
- Common tools: read_file, write_file, list_directory
- Always use absolute paths

### API Integrations
- Packages: "github", "notion-api", "slack", etc.
- May require authentication via \`authenticate\`
- Check health_check_all to verify connection status

### Search Operations
- Look for packages with "search" in the name
- Tools often have query parameters with specific syntax
- Use dry_run to test complex queries

## Error Recovery
- If a tool fails, check the error message for guidance
- Use \`get_help(error_code: <code>)\` for specific error help
- Verify authentication status for API packages
- Check argument types match the schema exactly`,

    authentication: `# Authentication in Super-MCP

## Overview
Some MCP packages require authentication to access their APIs (e.g., Notion, Slack, GitHub private repos).

## How to Authenticate
1. **Check Status**: Run \`health_check_all\` to see which packages need auth
2. **Start Auth**: Use \`authenticate(package_id: "package-name")\`
3. **Complete in Browser**: A browser window opens for authorization
4. **Verify**: Run \`health_check_all\` again to confirm authentication

## Package Types
- **Local (stdio)**: No authentication needed, runs locally
- **Public APIs**: May work without auth but with limitations
- **Private APIs**: Always require authentication (OAuth)

## Troubleshooting
- If authentication fails, try again - OAuth tokens can expire
- Some packages store tokens securely and remember authentication
- Check package documentation for specific auth requirements`,

    tool_discovery: `# Discovering Tools in Super-MCP

## Understanding Package Structure
Each package contains related tools:
- **filesystem**: File and directory operations
- **github**: Repository, issue, and PR management
- **notion-api**: Page and database operations
- **brave-search**: Web search capabilities

## Using list_tools Effectively
\`\`\`
list_tools(package_id: "github", summarize: true)
\`\`\`

Returns:
- Tool names and descriptions
- Argument skeletons showing expected format
- Schema hashes for validation

## Reading Tool Schemas
- Required fields are marked in the schema
- Check type constraints (string, number, boolean, object, array)
- Note any enum values for restricted options
- Look for format hints (uri, email, date)

## Tips
- Start with summarize: true for readable format
- Use include_schemas: true only when debugging
- Page through results if a package has many tools`,

    error_handling: `# Error Handling in Super-MCP

## Common Error Codes

### -32001: PACKAGE_NOT_FOUND
- The package_id doesn't exist
- Solution: Use \`list_tool_packages\` to see valid package IDs

### -32002: TOOL_NOT_FOUND
- The tool_id doesn't exist in the specified package
- Solution: Use \`list_tools(package_id)\` to see valid tool IDs

### -32003: ARG_VALIDATION_FAILED
- Arguments don't match the tool's schema
- Solution: Check the schema and ensure types match exactly
- Use dry_run: true to test arguments

### -32004: PACKAGE_UNAVAILABLE
- Package is configured but not responding
- Solution: Check \`health_check_all\` and verify configuration

### -32005: AUTH_REQUIRED
- Package needs authentication
- Solution: Use \`authenticate(package_id)\`

### -32007: DOWNSTREAM_ERROR
- The underlying MCP server returned an error
- Solution: Check error details and tool documentation

## Best Practices
- Always validate arguments match the schema
- Use dry_run for testing complex operations
- Check health status before troubleshooting
- Read error messages carefully - they often contain the solution`,

    common_patterns: `# Common Patterns in Super-MCP

## File Management Pattern
\`\`\`
1. list_tools(package_id: "filesystem")
2. use_tool(package_id: "filesystem", tool_id: "list_directory", args: {path: "/tmp"})
3. use_tool(package_id: "filesystem", tool_id: "read_file", args: {path: "/tmp/data.txt"})
4. use_tool(package_id: "filesystem", tool_id: "write_file", args: {path: "/tmp/output.txt", content: "..."})
\`\`\`

## API Search Pattern
\`\`\`
1. authenticate(package_id: "github")  // If needed
2. use_tool(package_id: "github", tool_id: "search_repositories", args: {query: "language:python"})
3. use_tool(package_id: "github", tool_id: "get_repository", args: {owner: "...", repo: "..."})
\`\`\`

## Data Processing Pattern
\`\`\`
1. Read data from one source
2. Process/transform the data
3. Write to another destination
4. Verify the operation succeeded
\`\`\`

## Diagnostic Pattern
\`\`\`
1. health_check_all(detailed: true)
2. Identify problematic packages
3. authenticate() if needed
4. Retry failed operations
\`\`\``,

    package_types: `# Package Types in Super-MCP

## Local (stdio) Packages
- Run as local processes on your machine
- No network latency
- Full access to local filesystem (with permissions)
- Examples: filesystem, git, docker
- Configuration: command and args

## HTTP/SSE Packages
- Connect to remote MCP servers
- May require authentication (OAuth)
- Subject to network latency and limits
- Examples: notion-api, slack, cloud services
- Configuration: url and optional headers

## Package Capabilities
Different packages offer different capabilities:

### Data Access
- filesystem: Local file operations
- database packages: SQL queries
- API packages: Cloud service data

### Automation
- git: Version control operations
- docker: Container management
- ci/cd packages: Pipeline control

### Integration
- notion-api: Workspace management
- slack: Communication automation
- github: Repository management

## Choosing Packages
- Use local packages for file/system operations
- Use HTTP packages for cloud services
- Check authentication requirements upfront
- Consider rate limits for API packages`,
  };

  return helpTopics[topic] || `Unknown help topic: ${topic}. Available topics: ${Object.keys(helpTopics).join(", ")}`;
}

export function getErrorHelp(errorCode: number): string {
  const errorHelp: Record<number, string> = {
    [-32001]: `# Error -32001: PACKAGE_NOT_FOUND

This error means the package_id you specified doesn't exist.

## How to Fix
1. Run \`list_tool_packages()\` to see all available packages
2. Copy the exact package_id from the response
3. Use that package_id in your request

## Common Causes
- Typo in package_id
- Package not configured in super-mcp-config.json
- Using tool name instead of package_id`,

    [-32002]: `# Error -32002: TOOL_NOT_FOUND

The tool_id doesn't exist in the specified package.

## How to Fix
1. Run \`list_tools(package_id: "your-package")\` 
2. Find the correct tool_id from the response
3. Use the exact tool name/id

## Common Causes
- Wrong package selected
- Tool name changed or deprecated
- Case sensitivity issues`,

    [-32003]: `# Error -32003: ARG_VALIDATION_FAILED

The arguments provided don't match the tool's expected schema.

## How to Fix
1. Run \`list_tools(package_id: "...", include_schemas: true)\`
2. Review the exact schema requirements
3. Ensure all required fields are present
4. Check that types match exactly (string vs number)
5. Use \`dry_run: true\` to test

## Common Issues
- Missing required fields
- Wrong data types (sending string instead of number)
- Invalid enum values
- Incorrect nesting of objects`,

    [-32004]: `# Error -32004: PACKAGE_UNAVAILABLE

The package exists but isn't responding.

## How to Fix
1. Run \`health_check_all()\` to check status
2. If it shows "error", check your configuration
3. For local packages, ensure the command is installed
4. For HTTP packages, check network connectivity

## Common Causes
- Local MCP server not installed
- Network issues for HTTP packages
- Incorrect configuration in super-mcp-config.json`,

    [-32005]: `# Error -32005: AUTH_REQUIRED

The package requires authentication before use.

## How to Fix
1. Run \`authenticate(package_id: "package-name")\`
2. Complete OAuth flow in browser
3. Try your operation again

## Notes
- Some packages require API keys in config
- OAuth tokens may expire and need refresh
- Check package documentation for auth setup`,

    [-32007]: `# Error -32007: DOWNSTREAM_ERROR

The underlying MCP server returned an error.

## How to Fix
1. Read the error message details carefully
2. Check if it's an auth issue (401/403)
3. Verify the operation is valid for that package
4. Check package-specific documentation

## Common Causes
- Expired authentication tokens
- Rate limiting
- Invalid operations for the package
- Permissions issues`,
  };

  const help = errorHelp[errorCode];
  if (help) {
    return help;
  }

  return `# Error Code ${errorCode}

This error code is not specifically documented.

## General Troubleshooting
1. Check the error message for details
2. Run \`health_check_all()\` to verify package status
3. Use \`list_tools\` to verify the tool exists
4. Validate arguments with \`dry_run: true\`
5. Check if authentication is needed

For more help, try:
- \`get_help(topic: "error_handling")\`
- \`get_help(topic: "workflow")\``;
}

export async function getPackageHelp(packageId: string, registry: PackageRegistry): Promise<string> {
  try {
    const pkg = registry.getPackage(packageId);
    if (!pkg) {
      return `# Package Not Found: ${packageId}

The package "${packageId}" doesn't exist.

Run \`list_tool_packages()\` to see available packages.`;
    }

    const catalog = new Catalog(registry);
    let toolCount = 0;
    let toolExamples = "";
    
    try {
      const tools = await catalog.getPackageTools(packageId);
      toolCount = tools.length;
      
      if (tools.length > 0) {
        const exampleTools = tools.slice(0, 5).map(t => `- ${t.tool.name}: ${t.tool.description || 'No description'}`).join('\n');
        toolExamples = `
## Available Tools (showing first 5 of ${toolCount})
${exampleTools}

Use \`list_tools(package_id: "${packageId}")\` to see all tools.`;
      }
    } catch (error) {
      logger.debug("Could not load tools for help", { package_id: packageId });
      toolExamples = `
## Tools
Unable to load tools. The package may require authentication.
Use \`authenticate(package_id: "${packageId}")\` if needed.`;
    }

    const authInfo = pkg.transport === "http" && pkg.oauth 
      ? `
## Authentication
This package requires OAuth authentication.
Use \`authenticate(package_id: "${packageId}")\` to connect.`
      : pkg.transport === "stdio"
      ? `
## Authentication
This is a local package - no authentication needed.`
      : "";

    return `# Package: ${pkg.name || packageId}

${pkg.description || 'No description available'}

## Basic Info
- **ID**: ${packageId}
- **Type**: ${pkg.transport}
- **Status**: Run \`health_check_all()\` to check
${pkg.transport === "http" ? `- **URL**: ${pkg.base_url || 'Not specified'}` : ''}
${toolExamples}
${authInfo}

## Usage Example
\`\`\`
// 1. List available tools
list_tools(package_id: "${packageId}")

// 2. Execute a tool
use_tool(
  package_id: "${packageId}",
  tool_id: "tool_name",
  args: { /* tool-specific arguments */ }
)
\`\`\`

## Troubleshooting
- If tools aren't working, check \`health_check_all()\`
- For detailed schemas: \`list_tools(package_id: "${packageId}", include_schemas: true)\`
- Test arguments: Add \`dry_run: true\` to use_tool`;

  } catch (error) {
    return `Error generating help for package ${packageId}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
