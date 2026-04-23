import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'workspace-env-fixture',
  version: '1.0.0',
});

server.registerTool(
  'get-env-snapshot',
  {
    description: 'Returns selected environment variables for the workspace env integration test.',
    inputSchema: {},
  },
  async () => {
    const snapshot = {
      version: 'd17-fixture-v1',
      mcpWorkspacePath: process.env.MCP_WORKSPACE_PATH ?? null,
      rebelWorkspacePath: process.env.REBEL_WORKSPACE_PATH ?? null,
      customMarker: process.env.CUSTOM_MARKER ?? null,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(snapshot) }],
    };
  },
);

await server.connect(new StdioServerTransport());
