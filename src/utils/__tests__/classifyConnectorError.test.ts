import { describe, expect, it } from "vitest";

import type { PackageConfig } from "../../types.js";
import { classifyConnectorError } from "../classifyConnectorError.js";

const config: PackageConfig = {
  id: "remote-test",
  name: "Remote test",
  transport: "http",
  base_url: "https://mcp.example.test/mcp",
  visibility: "default",
  oauth: true,
};

describe("classifyConnectorError", () => {
  it("keeps OAuth-shaped transport prose transient", () => {
    expect(
      classifyConnectorError(
        config,
        new Error("OAuth authorization endpoint returned HTTP 503"),
      ),
    ).toMatchObject({
      kind: "transient_failure",
      failureClass: "transport_error",
    });
  });

  it("does not treat unsupported unauthorized prose as auth evidence", () => {
    expect(
      classifyConnectorError(config, new Error("Unauthorized upstream proxy response: HTTP 503")),
    ).toMatchObject({
      kind: "transient_failure",
      failureClass: "transport_error",
    });
  });

  it.each([
    new Error("HTTP 401"),
    Object.assign(new Error("grant rejected"), { code: "invalid_token" }),
    Object.assign(new Error("scope rejected"), { code: "insufficient_scope" }),
  ])("recognizes explicit auth evidence", (error) => {
    expect(classifyConnectorError(config, error)).toMatchObject({
      kind: "auth_required",
    });
  });
});
