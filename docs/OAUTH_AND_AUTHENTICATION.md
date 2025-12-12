# OAuth and Authentication

Super MCP supports two authentication methods for MCP packages: API keys passed via environment variables and OAuth for hosted services requiring user authorization.

## See Also

- [README.md](../README.md) — Basic authentication configuration and quick start
- [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md) — Full configuration schema including `oauth` and `env` fields
- [src/clients/httpClient.ts](../src/clients/httpClient.ts) — OAuth flow implementation and HTTP transport
- [src/auth/callbackServer.ts](../src/auth/callbackServer.ts) — Local OAuth callback server
- [src/auth/providers/](../src/auth/providers/) — OAuth provider implementations (SimpleOAuthProvider, RefreshOnlyOAuthProvider)

---

## Authentication Methods

| Method | Use Case | Configuration |
|--------|----------|---------------|
| Environment Variables | API keys (GitHub, Brave Search, etc.) | `env` field in server config |
| OAuth | Hosted services (Notion, Slack, etc.) | `"oauth": true` + `authenticate()` meta-tool |

---

## Environment Variable Authentication

For MCP servers that require API keys or tokens, configure them in the `env` field of the server configuration.

### Configuration Example

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

### Variable Expansion Syntax

Super MCP supports environment variable expansion in the `env` field:

- `${VAR}` — Standard syntax with braces
- `$VAR` — Short syntax without braces

Both syntaxes reference the corresponding variable from your shell environment.

### Security Model

**Only explicitly configured variables are passed to MCP servers.** Super MCP does not pass `process.env` wholesale to child processes. This prevents:

- Accidental leakage of sensitive environment variables
- Servers accessing unintended credentials
- Environment pollution across packages

---

## OAuth Flow

For hosted services that require user authorization (e.g., Notion, Slack, Google services), Super MCP implements a browser-based OAuth flow.

### Enabling OAuth

Add `"oauth": true` to your server configuration:

```json
{
  "mcpServers": {
    "notion-api": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp",
      "oauth": true,
      "name": "Notion Integration",
      "description": "Access and manage Notion workspaces"
    }
  }
}
```

### Authentication Process

1. **Initiate**: Use the `authenticate` meta-tool:
   ```
   authenticate(package_id: "notion-api")
   ```

2. **Browser Authorization**: Super MCP opens your default browser to the service's OAuth authorization page

3. **Callback**: After you authorize, the browser redirects to a local callback server (ports 5173-5182)

4. **Token Exchange**: Super MCP exchanges the authorization code for access and refresh tokens

5. **Storage**: Tokens are securely stored for future use (see Token Storage below)

### Callback Server Port Selection

The OAuth callback server dynamically selects an available port:

- **Range**: 5173-5182 (10 ports)
- **Selection**: First available port in range
- **Fallback**: If all ports are in use, authentication fails with a clear error message

---

## OAuth Providers

Super MCP includes two OAuth provider implementations that handle different scenarios:

### SimpleOAuthProvider

**Purpose**: Full browser-based OAuth flow for initial authentication.

**When Used**:
- First-time authentication (no tokens exist)
- Explicitly requested via `authenticate()` meta-tool
- After token invalidation

**Behavior**:
- Opens browser to authorization URL
- Handles callback server lifecycle
- Exchanges authorization code for tokens
- Persists tokens to storage

### RefreshOnlyOAuthProvider

**Purpose**: Silent token refresh without browser interaction.

**When Used**:
- Existing tokens are found during `connect()`
- Tokens need refresh before expiry

**Behavior**:
- Uses existing refresh token to obtain new access token
- No browser popup during normal operations
- If refresh fails, throws error directing user to `authenticate()`

### Provider Selection Logic

```
connect() called
    │
    ├─▶ Has existing tokens?
    │       │
    │       ├─▶ Yes: Use RefreshOnlyOAuthProvider
    │       │       (silent refresh, no browser)
    │       │
    │       └─▶ No: Connect without auth
    │               (may fail with 401)
    │
authenticate() called
    │
    └─▶ Always use SimpleOAuthProvider
            (full browser flow)
```

---

## Token Storage

### Storage Location

Tokens are stored in `~/.super-mcp/oauth-tokens/`:

```
~/.super-mcp/
└── oauth-tokens/
    ├── notion-api_client.json    # OAuth client info
    ├── notion-api_tokens.json    # Access/refresh tokens
    ├── slack_client.json
    └── slack_tokens.json
```

### Security

- **File permissions**: Created with `0600` (owner read/write only)
- **Contents**: Access token, refresh token, expiry timestamp
- **Client info**: Client ID stored separately for mismatch detection

### Token Structure

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer"
}
```

---

## Troubleshooting

### "Client ID mismatch"

**Cause**: The OAuth client registration changed on the server side, invalidating existing tokens.

**Solution**: 
1. Tokens are automatically cleared when this error occurs
2. Run `authenticate(package_id: "...")` to re-authorize
3. The error message includes the exact command to run

### "401 Unauthorized" or "Authentication required"

**Cause**: No valid tokens exist, or tokens have expired and refresh failed.

**Solution**:
```
authenticate(package_id: "package-name")
```

### "Port in use" during OAuth

**Cause**: All callback server ports (5173-5182) are occupied by other processes.

**Solution**:
1. Check for other development servers using these ports
2. Free up a port in the 5173-5182 range
3. Retry authentication

### Checking Authentication Status

Use the `health_check_all` meta-tool to verify auth status of all packages:

```
health_check_all()
```

Returns status for each package:
- `"ok"` — Connected and authenticated
- `"needs_auth"` — OAuth required, run `authenticate()`
- `"error"` — Connection or other error

---

## Maintenance

This document should be updated when:
- OAuth flow implementation changes in `src/auth/`
- New authentication providers are added
- Token storage location or format changes
- Callback server port range changes
