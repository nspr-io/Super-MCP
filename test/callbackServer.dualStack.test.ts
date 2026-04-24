import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import * as net from "net";
import { OAuthCallbackServer } from "../src/auth/callbackServer.js";
import {
  OAUTH_CALLBACK_HOST_V4,
  OAUTH_CALLBACK_HOST_V6,
  findAvailablePort,
} from "../src/utils/portFinder.js";

/**
 * Regression cover for the IPv4/IPv6 callback 404 bug
 * (docs/investigations/260225_oauth_callback_connection_refused.md).
 *
 * The OAuth callback server must accept connections from BOTH `127.0.0.1` and
 * `::1` (when IPv6 loopback is available on the host) because browsers resolve
 * `localhost` to either stack in ways we can't predict from userland.
 */

function ipv6LoopbackUsable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(0, OAUTH_CALLBACK_HOST_V6);
  });
}

function httpGet(options: http.RequestOptions): Promise<{
  statusCode: number | undefined;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("OAuthCallbackServer dual-stack binding", () => {
  let server: OAuthCallbackServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("responds on 127.0.0.1 after start", async () => {
    const port = await findAvailablePort(5173, 10);
    server = new OAuthCallbackServer(port);
    await server.start();

    const res = await httpGet({
      hostname: OAUTH_CALLBACK_HOST_V4,
      port,
      path: "/oauth/callback?error=test_error",
      family: 4,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("test_error");
  });

  it("responds on ::1 when IPv6 loopback is usable", async () => {
    if (!(await ipv6LoopbackUsable())) {
      // IPv6 loopback not available on this host (e.g. some CI containers);
      // IPv4-only is the documented fallback path. Nothing to assert here.
      return;
    }
    const port = await findAvailablePort(5173, 10);
    server = new OAuthCallbackServer(port);
    await server.start();

    const res = await httpGet({
      hostname: OAUTH_CALLBACK_HOST_V6,
      port,
      path: "/oauth/callback?error=test_error",
      family: 6,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("test_error");
  });

  it("stop() closes every listener and releases the port on both stacks", async () => {
    const port = await findAvailablePort(5173, 10);
    server = new OAuthCallbackServer(port);
    await server.start();
    await server.stop();
    server = undefined;

    // Rebinding on v4 must succeed immediately after stop().
    const probeV4 = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => {
        s.close(() => resolve(true));
      });
      s.listen(port, OAUTH_CALLBACK_HOST_V4);
    });
    expect(probeV4).toBe(true);

    if (await ipv6LoopbackUsable()) {
      const probeV6 = await new Promise<boolean>((resolve) => {
        const s = net.createServer();
        s.once("error", () => resolve(false));
        s.once("listening", () => {
          s.close(() => resolve(true));
        });
        s.listen(port, OAUTH_CALLBACK_HOST_V6);
      });
      expect(probeV6).toBe(true);
    }
  });
});
