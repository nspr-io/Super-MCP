# Changelog

All notable changes to Super MCP Router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2025-11-27

### Added
- **Output truncation support**: New `max_output_chars` parameter on `use_tool` to prevent context overflow
  - When specified, tool outputs exceeding the limit are truncated with a clear indicator
  - Truncation metadata included in telemetry (`output_truncated`, `original_output_chars`)
- **Large output warnings**: Automatic warning hints when tool outputs exceed 150k characters (~37.5k tokens)
  - Warning suggests using `max_output_chars` parameter to prevent context overflow
  - Enables AI agents to self-recover by retrying with output limits
- **Output size telemetry**: All tool results now include `output_chars` in telemetry for monitoring

### Changed
- `UseToolOutput` telemetry now includes optional fields: `output_chars`, `output_truncated`, `original_output_chars`

## [1.4.0] - 2025-10-08

### Added
- **Configurable tool timeouts**: Support for per-server timeout configuration via `timeout` field
- **Global timeout environment variable**: `SUPER_MCP_TOOL_TIMEOUT` for setting default timeout across all servers
- **Progress-based timeout reset**: Timeouts automatically reset when MCP servers send progress notifications
- **Increased default timeout**: Changed from 60 seconds to 5 minutes (300,000ms) for better support of long-running operations

### Changed
- Default tool execution timeout increased from 60 seconds to 5 minutes
- Tool timeouts now properly passed through to MCP SDK for both stdio and HTTP transports
- Timeout configuration now supports three levels: per-server config > global env var > default (300s)

### Fixed
- Fixed issue where MCP tool calls were timing out at hardcoded 60 seconds regardless of configuration
- Long-running tools (research, data processing, complex queries) can now complete successfully

## [1.3.0] - 2025-01-11

### Added
- **Zero-config setup**: Automatically creates `~/.super-mcp/` directory and config on first run
- **CLI for adding MCPs**: Simple `add` command to add pre-configured MCP servers
- **Empty config support**: Super MCP Router now works with no MCPs configured (minimal mode)
- **Auto-setup**: Creates directories, logs folder, and empty config automatically

### Changed
- **Simplified onboarding**: No manual config creation needed - just add to Claude and restart
- **Default config location**: Now defaults to `~/.super-mcp/config.json` if no config specified
- **Better first-run experience**: Helpful messages guide users on next steps

### Fixed
- Config validation no longer requires at least one server

## [1.2.0] - 2025-01-11

### Added
- **Comprehensive error messaging**: All errors now provide actionable diagnostics and troubleshooting steps
- **Environment variable expansion**: Support for `${VAR}` and `$VAR` syntax in configuration files
- **JSON Schema format validation**: Added support for standard formats (date, date-time, email, etc.) via ajv-formats
- **OAuth token invalidation**: Automatic cleanup of invalid OAuth tokens when "Client ID mismatch" occurs
- **Enhanced health check diagnostics**: Detailed per-package status with suggested actions
- **Improved validation errors**: Clear guidance on missing/incorrect arguments with schema hints

### Changed
- **Security improvement**: Only explicitly configured environment variables are passed to MCP servers (no longer passes entire process.env)
- **Better connection error handling**: Specific diagnostics for command not found, permission denied, and network issues
- **Clearer tool execution errors**: Context-aware error messages based on failure type (timeout, auth, permissions)

### Fixed
- **Notion OAuth browser not opening**: Fixed issue where browser wouldn't open when invalid tokens were present
- **Notion search failures**: Fixed validation errors with date formats in Notion search filters
- **Environment variable security**: Prevented leaking of all system environment variables to MCP servers

### Security
- Environment variables are now isolated per MCP server - each server only receives explicitly configured variables
- Sensitive values (tokens, keys) are never logged in debug output

## [1.1.0] - 2025-01-09

### Added
- Support for multiple configuration files via multiple --config arguments
- Support for comma-separated config paths in SUPER_MCP_CONFIG environment variable
- Automatic merging of servers from multiple config files (duplicates handled gracefully)

### Changed
- Configuration loading now supports both single and multiple file inputs
- Backward compatible - existing single config setups continue to work unchanged

## [1.0.4] - 2025-01-09

### Changed
- Reorganized README to prioritize npx (no-installation) method
- Improved documentation flow to make getting started easier
- Moved installation methods to a dedicated section

## [1.0.3] - 2025-01-09

### Fixed
- Fixed critical stdout pollution issue that broke MCP protocol when using npx
- Logger now correctly outputs to stderr instead of stdout, ensuring clean JSON-RPC communication
- This fix makes npx execution reliable for fresh installations

## [1.0.2] - 2025-01-06

### Added
- Support for new Streamable HTTP transport type (recommended for HTTP servers)
- Support for `cwd` configuration field to specify working directory for server processes
- Improved authentication error messages that guide users to authenticate when needed
- Browser-based OAuth provider with callback server for OAuth flows
- Global OAuth lock coordination to prevent concurrent OAuth flows

### Changed
- HTTP transport type detection now uses configured `type` field instead of URL-based detection
- Enhanced error handling for 401/Unauthorized responses with clearer user guidance
- Updated documentation to reflect HTTP+SSE deprecation (as of MCP spec 2025-03-26)

### Deprecated
- HTTP+SSE transport (`type: "sse"`) is now deprecated in favour of Streamable HTTP (`type: "http"`)

## [1.0.1] - 2025-01-01

### Added
- Device code OAuth flow support
- Token storage with OS keychain integration (with file fallback)
- Built-in help system with `get_help` tool
- Comprehensive error codes and contextual help

### Changed
- Improved logging with structured output
- Enhanced tool discovery and caching

## [1.0.0] - 2024-12-25

### Added
- Initial release of Super MCP Router
- Support for multiple MCP servers (stdio and HTTP)
- Meta-tools for package discovery and management
- Tool validation with Ajv schemas
- Basic OAuth support for HTTP servers