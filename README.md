# Super MCP Router

A local MCP router that aggregates multiple MCPs into a single interface for Claude. No installation required - just use npx!

## Overview

Super MCP Router allows you to configure multiple MCP servers (both local stdio and hosted HTTP) and access them through a single unified interface with these meta-tools:

- `list_tool_packages` - List available MCP packages and discover their capabilities
- `list_tools` - List tools in a specific package with schemas and examples
- `use_tool` - Execute a tool from any package
- `get_help` - Get detailed guidance on using Super-MCP effectively
- `authenticate` - Start OAuth authentication for packages that require it
- `health_check_all` - Check the operational status of all configured packages

## Quick Start (No Installation Required!)

### 1. Add to Claude Desktop

Add this to your Claude Desktop MCP settings:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "super-mcp": {
      "command": "npx",
      "args": ["-y", "super-mcp-router@latest"]
    }
  }
}
```

### 2. Restart Claude Desktop

That's it! Super MCP Router will automatically:
- Create `~/.super-mcp/` directory
- Create an empty config file
- Start working immediately (even with no MCPs configured)

### 3. Add MCP Servers (Optional)

Use the simple CLI to add MCP servers:

```bash
# Add common MCP servers
npx super-mcp-router add filesystem
npx super-mcp-router add github
npx super-mcp-router add memory

# See available servers
npx super-mcp-router add --help
```

Or manually edit `~/.super-mcp/config.json` to add custom MCPs.

## Configuration

Super MCP Router supports the standard MCP `mcpServers` configuration format, making it easy to drop in existing MCP server configurations.

Create a `super-mcp-config.json` file:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/directory"
      ]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_GITHUB_TOKEN"
      }
    },
    "notion-api": {
      "type": "sse",
      "url": "https://mcp.notion.com/mcp",
      "oauth": true,
      "name": "Notion Integration",
      "description": "Access and manage Notion workspaces"
    }
  }
}
```

### Configuration Options

**Standard MCP fields:**
- `command`: Command to execute (for stdio servers)
- `args`: Command arguments
- `env`: Environment variables (supports variable expansion - see below)
- `cwd`: Working directory for the server process
- `type`: Transport type:
  - `"stdio"`: Local command execution
  - `"sse"`: HTTP+SSE transport (deprecated as of MCP spec 2025-03-26)
  - `"http"`: Streamable HTTP transport (recommended for HTTP servers)
- `url`: Server URL (for HTTP servers)
- `headers`: HTTP headers for authentication

**Extended fields (super-mcp specific):**
- `oauth`: Enable OAuth authentication (boolean)
- `name`: Human-readable name for the package
- `description`: Description of the package's capabilities
- `visibility`: "default" or "hidden" (controls display in tool lists)
- `timeout`: Tool execution timeout in milliseconds (default: 300000 = 5 minutes)

### Environment Variable Expansion

Super MCP Router supports environment variable expansion in the `env` field using `${VAR}` or `$VAR` syntax:

```json
{
  "github": {
    "command": "npx",
    "args": ["@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
    }
  }
}
```

This allows you to:
- Keep sensitive tokens out of configuration files
- Share configurations without exposing credentials
- Use different values across environments

**Security Note**: Only explicitly configured environment variables are passed to MCP servers. This prevents leaking system environment variables to individual servers.

### Configuring Tool Timeouts

Super MCP Router supports configurable timeouts for long-running tool executions. By default, tools timeout after 5 minutes (300,000ms), but you can customize this per-server or globally.

**Per-Server Timeout:**
```json
{
  "mcpServers": {
    "deep-research": {
      "command": "npx",
      "args": ["-y", "octagon-deep-research-mcp@latest"],
      "timeout": 600000,  // 10 minutes for deep research tasks
      "env": {
        "OCTAGON_API_KEY": "your_api_key"
      }
    }
  }
}
```

**Global Timeout (Environment Variable):**
```bash
export SUPER_MCP_TOOL_TIMEOUT=600000  # 10 minutes default for all tools
```

**How Timeouts Work:**
- Default timeout: 300,000ms (5 minutes)
- Per-server `timeout` config overrides the default
- `SUPER_MCP_TOOL_TIMEOUT` environment variable provides a global default
- Timeout automatically resets when the tool sends progress notifications
- Useful for long-running operations like research, data processing, or complex queries

## CLI Commands

Super MCP Router includes a simple CLI for managing MCP servers:

### Adding MCP Servers

```bash
# Add pre-configured MCP servers
npx super-mcp-router add filesystem  # Adds filesystem access
npx super-mcp-router add github      # Adds GitHub integration 
npx super-mcp-router add memory      # Adds persistent memory

# See available servers
npx super-mcp-router add --help
```

The `add` command:
- Adds servers to `~/.super-mcp/config.json`
- Uses sensible defaults (e.g., `~/Documents` for filesystem)
- Reminds you about required environment variables

### Default Config Location

If no `--config` is specified, Super MCP Router uses:
- `~/.super-mcp/config.json` (auto-created if missing)

You can still use custom locations:
```bash
npx super-mcp-router --config /custom/path/config.json
```

## Using Multiple Configuration Files

You can split your MCP servers across multiple configuration files for better organization. This is useful for:
- Separating personal and work MCPs
- Grouping MCPs by functionality (e.g., dev tools, AI services, databases)
- Sharing common configurations across projects
- Managing team-wide vs personal tool configurations

### Method 1: Multiple --config Arguments

In your Claude configuration, you can specify multiple config files:

```json
{
  "mcpServers": {
    "Super-MCP": {
      "command": "npx",
      "args": [
        "-y",
        "super-mcp-router@latest",
        "--config",
        "/Users/YOU/.super-mcp/personal-mcps.json",
        "--config",
        "/Users/YOU/.super-mcp/work-mcps.json",
        "--config",
        "/Users/YOU/.super-mcp/shared-mcps.json"
      ]
    }
  }
}
```

### Method 2: Environment Variable (Comma-Separated)

Set the environment variable with comma-separated paths:

```bash
export SUPER_MCP_CONFIG="/path/to/personal.json,/path/to/work.json,/path/to/shared.json"
```

Then use Super MCP normally - it will automatically load all specified configs.

### Example: Organizing by Function

**dev-tools.json:**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/YOU/dev"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

**ai-services.json:**
```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "YOUR_KEY" }
    }
  }
}
```

### Important Notes

- **Duplicate IDs**: If the same server ID appears in multiple configs, the last one loaded takes precedence (with a warning logged)
- **Error Handling**: If any config file fails to load, the entire startup fails (fail-fast behavior)
- **Backward Compatible**: Single config files work exactly as before - no changes needed to existing setups
- **Legacy Format**: The old `packages` array format is still supported and automatically converted

## Alternative Installation Methods

While npx is the recommended way to use Super MCP Router (no installation, always up-to-date), you can also:

### Install Globally

```bash
npm install -g super-mcp-router
```

Then use in Claude config:
```json
{
  "mcpServers": {
    "Super-MCP": {
      "command": "super-mcp-router",
      "args": [
        "--config",
        "/Users/YOUR_USERNAME/.super-mcp/super-mcp-config.json"
      ]
    }
  }
}
```

To update: `npm update -g super-mcp-router`

### Clone and Build from Source (For Development)

```bash
git clone https://github.com/JoshuaWohle/Super-MCP.git
cd Super-MCP
npm install
npm run build
```

Then use in Claude config:
```json
{
  "mcpServers": {
    "Super-MCP": {
      "command": "node",
      "args": [
        "/absolute/path/to/Super-MCP/dist/cli.js",
        "--config",
        "/Users/YOUR_USERNAME/.super-mcp/super-mcp-config.json"
      ]
    }
  }
}
```

To update:
```bash
cd /path/to/Super-MCP
git pull
npm install
npm run build
```

## Features

- **Single Interface**: Access all your MCPs through one connection
- **Mixed Transports**: Combine stdio and HTTP MCPs seamlessly
- **HTTP Transport Support**: Both HTTP+SSE (legacy) and Streamable HTTP (recommended)
- **OAuth Support**: Browser-based OAuth flow with persistent token storage
- **Tool Discovery**: Automatic tool enumeration and caching
- **Validation**: Schema validation for all tool arguments
- **Error Handling**: Comprehensive error codes and messages with contextual help
- **Improved Authentication**: Clear error messages guiding users to authenticate when needed
- **Built-in Help System**: Interactive guidance with `get_help` tool
- **Portable**: Everything contained within this directory

## Project Structure

```
src/
├── cli.ts              # CLI entry point
├── server.ts           # MCP server with meta-tools
├── registry.ts         # Config loading & package management
├── catalog.ts          # Tool caching & discovery
├── summarize.ts        # Tool summaries & arg skeletons
├── validator.ts        # Argument validation
├── logging.ts          # Structured logging
├── types.ts            # TypeScript definitions
├── auth/
│   ├── manager.ts      # Token storage (keychain + file fallback)
│   ├── deviceCode.ts   # Device code OAuth flow
│   ├── browserOAuthProvider.ts # Browser OAuth provider
│   ├── callbackServer.ts # OAuth callback server
│   └── globalOAuthLock.ts # OAuth flow coordination
└── clients/
    ├── stdioClient.ts  # Stdio MCP client
    └── httpClient.ts   # HTTP MCP client
```

## Security

- **Never commit your `super-mcp-config.json`** - it contains API keys and credentials
- Tokens stored securely in OS keychain (with file fallback)
- All sensitive data redacted from logs
- File tokens created with 0600 permissions
- Device code flow (no local HTTP server required)

⚠️ **Important**: The `.gitignore` file excludes your config file, but double-check before committing!

## Built-in Help System

Super MCP includes comprehensive built-in help accessible through the `get_help` tool:

### Help Topics
- **getting_started**: Basic workflow and examples
- **workflow**: Common usage patterns
- **authentication**: OAuth and API key setup
- **tool_discovery**: Finding and understanding available tools
- **error_handling**: Troubleshooting error codes
- **common_patterns**: Typical usage scenarios
- **package_types**: Understanding different MCP types

### Usage Examples
```javascript
// Get started with Super MCP
get_help(topic: "getting_started")

// Get help for a specific package
get_help(package_id: "github")

// Get help for an error code
get_help(error_code: -32003)
```

### Enhanced Error Messages
All errors now include contextual guidance pointing to relevant help resources and suggesting next steps.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- --config ./super-mcp-config.json

# Build for production
npm run build
```