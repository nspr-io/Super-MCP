# Super-MCP Transport Modes

Comparison of STDIO and HTTP transport modes for Super-MCP connections, with guidance on when to use each.

## See Also

- [README.md](../README.md) – Transport mode quick start and configuration
- [src/clients/stdioClient.ts](../src/clients/stdioClient.ts) – STDIO transport implementation
- [src/clients/httpClient.ts](../src/clients/httpClient.ts) – HTTP transport implementation
- [src/server.ts](../src/server.ts) – Server-side transport selection

---

## Transport Mode Comparison

| Aspect | STDIO | HTTP |
|--------|-------|------|
| Best for | Local Claude Desktop | Multiple instances, cloud deployments |
| Latency | ~50-100ms | ~60-120ms |
| Concurrency | Serialized (queue=1) | Parallel (queue=5) |
| Setup | Zero config | Port required |
| Multiple instances | No (conflicts) | Yes |
| Debugging | Harder (stdin/stdout) | HTTP tools available (curl, Postman) |

---

## STDIO Mode

STDIO transport uses stdin/stdout pipes for communication. It's the simplest transport to configure but has concurrency limitations.

### How It Works

- Communicates via stdin/stdout pipes to spawned child processes
- Uses a request queue with `concurrency=1` to serialize all requests
- Serialization avoids "stream busy" race conditions documented in SDK issues

### Known Issues

The single-concurrency queue addresses known race conditions:
- [csharp-sdk#88](https://github.com/modelcontextprotocol/csharp-sdk/issues/88)
- [python-sdk#824](https://github.com/modelcontextprotocol/python-sdk/issues/824)
- [fastmcp#1625](https://github.com/jlowin/fastmcp/issues/1625)

### When to Use STDIO

- Local Claude Desktop integration
- Simple single-client setups
- Quick testing without network configuration
- When package spawns its own process

### Configuration Example

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

---

## HTTP Mode

HTTP transport uses network connections for communication. It supports higher concurrency and is better suited for multi-instance deployments.

### How It Works

- Communicates over HTTP network connections
- Uses a request queue with `concurrency=5` for parallel requests
- Each connection is independent (no shared stream issues)
- Default port: 3000

### HTTP Transport Types

Super-MCP supports two HTTP sub-types:

| Type | Description | Status |
|------|-------------|--------|
| `"sse"` | HTTP + Server-Sent Events | **Deprecated** (MCP spec 2025-03-26) |
| `"http"` | Streamable HTTP | **Recommended** |

When `type` is omitted for HTTP servers, Streamable HTTP is used by default.

### When to Use HTTP

- Concurrent agent sessions
- Cloud/server deployments
- Load-balanced configurations
- Development and debugging (easier to inspect traffic)
- When multiple Claude instances need the same MCP

### Configuration Examples

**Basic HTTP (Streamable HTTP - recommended):**
```json
{
  "mcpServers": {
    "my-mcp": {
      "url": "http://localhost:3000/mcp",
      "type": "http"
    }
  }
}
```

**HTTP + SSE (deprecated):**
```json
{
  "mcpServers": {
    "my-mcp": {
      "url": "http://localhost:3000/sse",
      "type": "sse"
    }
  }
}
```

---

## Choosing a Transport

### Use STDIO When:

- Running locally with Claude Desktop
- You have a simple single-client setup
- The MCP server spawns its own process (command + args)
- You want zero network configuration

### Use HTTP When:

- Running concurrent sessions from multiple agents
- Deploying to cloud or server environments
- You need to debug or monitor MCP traffic
- Multiple Claude instances share the same MCP server
- You want better scalability (5x concurrency vs 1x)

---

## Server-Side Transport Selection

When running Super-MCP as a server, select transport mode via CLI:

```bash
# STDIO mode (default)
npx super-mcp --config super-mcp-config.json

# HTTP mode
npx super-mcp --config super-mcp-config.json --transport http --port 3000
```

The server exposes a health endpoint in HTTP mode at `/health`:

```bash
curl http://localhost:3000/health
# {"status":"ok","transport":"http"}
```

---

## Maintenance

Update this document when:
- Transport behavior or concurrency limits change
- New transport types are added
- SDK transport APIs are updated
- Default port or configuration options change
