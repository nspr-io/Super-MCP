# Security Hardening

This document tracks security hardening measures implemented in Super-MCP.

## Implemented (2025-12-26)

### CRITICAL Priority

1. **Localhost Binding** (`server.ts`, `callbackServer.ts`)
   - HTTP server binds to `127.0.0.1` only (not `0.0.0.0`)
   - Prevents remote network access to local MCP server

2. **Command Injection Prevention** (`providers/simple.ts`)
   - Browser launch uses `spawn()` instead of `exec()`
   - Eliminates shell metacharacter injection risk

### HIGH Priority

3. **File Permission Hardening** (`simple.ts`, `cli.ts`, `logging.ts`)
   - Directories created with mode `0o700`
   - Files created with mode `0o600`
   - Applies to token storage, config files, and logs

4. **PKCE Validation** (`providers/simple.ts`)
   - Throws error if code verifier missing (previously returned dummy value)
   - Ensures OAuth PKCE flow integrity

5. **Tool Argument Validation Ordering** (`handlers/useTool.ts`)
   - Validation happens BEFORE dry_run check
   - Ensures all tool executions are validated

### MEDIUM Priority

6. **ReDoS Protection** (`security.ts`)
   - Uses `safe-regex2` to validate user-defined regex patterns
   - Rejects patterns vulnerable to catastrophic backtracking
   - MAX_PATTERN_LENGTH = 500 chars
   - MAX_INPUT_LENGTH = 100 chars for tool/package names
   - Handles RegExp g/y flag statefulness

7. **Log Redaction** (`logging.ts`)
   - Detects URLs anywhere in log values (not just at string start)
   - Redacts sensitive query params: token, key, secret, password, code, access_token, refresh_token, client_secret, api_key, apikey
   - Case-insensitive parameter matching
   - Redacts URL fragments (#access_token=...)
   - Redacts userinfo (user:password@host)

8. **OAuth State Parameter** (`providers/simple.ts`, `callbackServer.ts`, `authenticate.ts`)
   - Implements `state()` method with 256-bit cryptographic entropy
   - Callback server validates state with timing-safe comparison
   - Prevents login CSRF attacks

9. **DNS Rebinding Protection** (`server.ts`)
   - Host header validation on `/mcp` endpoint
   - Rejects requests with Host != localhost/127.0.0.1
   - Case-insensitive matching per RFC 7230

## Deferred (Future Work)

### Port Race Condition (MEDIUM - Stage 3)

**Issue:** TOCTOU race between port availability check and binding.

**Status:** Deferred - fix would break OAuth redirect_uri flow.

**Rationale:** The retry mechanism would cause port to change after OAuth provider registration, breaking callbacks. Needs OAuth flow restructuring which is invasive.

**Risk:** Low - window is tiny and attack requires precise timing + local process.

### Bearer Token Authentication (MEDIUM - Stage 5b)

**Issue:** HTTP `/mcp` endpoint has no authentication.

**Status:** Deferred - requires cross-repo coordination with parent app.

**Rationale:** 
- Token handoff mechanism needs parent app changes
- Host validation already closes DNS rebinding vector
- Localhost binding limits attack surface

**When to implement:**
- When parent app can generate token and pass via env var
- Consider `SUPER_MCP_AUTH_TOKEN` environment variable approach

## Testing

Super-MCP currently has no automated test suite. Security changes were verified via:
- TypeScript compilation (`npm run build`)
- Triple-review process with multiple LLM reviewers
- Manual testing where applicable

Future work should add tests for:
- ReDoS pattern rejection
- Log redaction edge cases
- OAuth state validation
- Host header validation

## References

- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/concepts/security)
- CVE-2025-66414, CVE-2025-66416 (MCP DNS rebinding)
- CVE-2025-49596 (MCP Inspector RCE)
