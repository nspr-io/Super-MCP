import { describe, it, expect } from "vitest";
import { Validator, ValidationError } from "../src/validator.js";
import { handleUseTool } from "../src/handlers/useTool.js";
import { ERROR_CODES } from "../src/types.js";

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function createUseToolDeps(schema: any) {
  const registry = {
    getPackage: () => ({ id: "mock" }),
    getClient: async () => ({
      callTool: async () => ({ ok: true }),
    }),
    notifyActivity: () => {},
  };

  const catalog = {
    ensurePackageLoaded: async () => {},
    getPackageStatus: () => "ready",
    getPackageError: () => null,
    getToolSchema: async () => schema,
  };

  return {
    registry,
    catalog,
    validator: new Validator(),
  };
}

async function runValidationFailure(options: {
  schema: any;
  args: any;
  packageId?: string;
  toolId?: string;
}) {
  const packageId = options.packageId ?? nextId("pkg");
  const toolId = options.toolId ?? nextId("tool");
  const { registry, catalog, validator } = createUseToolDeps(options.schema);

  try {
    await handleUseTool(
      {
        package_id: packageId,
        tool_id: toolId,
        args: options.args,
        dry_run: true,
      },
      registry as any,
      catalog as any,
      validator,
    );
    throw new Error("Expected validation failure");
  } catch (error) {
    return error as any;
  }
}

function expectRepairTicket(error: any): any {
  expect(error.code).toBe(ERROR_CODES.ARG_VALIDATION_FAILED);
  expect(error.message).toContain("Argument validation failed");
  expect(error.data).toBeDefined();
  expect(error.data.repair_ticket).toBeDefined();
  return error.data.repair_ticket;
}

describe("Validator", () => {
  it("returns valid=true for valid data", () => {
    const validator = new Validator();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    const result = validator.validate(schema, { name: "test", age: 25 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.strippedArgs).toEqual([]);
  });

  it("returns valid=false for missing required field", () => {
    const validator = new Validator();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };

    const result = validator.validate(schema, {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid=false for invalid type", () => {
    const validator = new Validator();
    const schema = {
      type: "object",
      properties: {
        age: { type: "number" },
      },
    };

    const result = validator.validate(schema, { age: "not-a-number" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("throws ValidationError when schema is missing", () => {
    const validator = new Validator();
    expect(() => validator.validate(null, {})).toThrow(ValidationError);
  });

  describe("arg stripping (additionalProperties: false)", () => {
    it("strips unknown top-level properties and returns their names", () => {
      const validator = new Validator();
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      };
      const data = { query: "test", limit: 10, mode: "fast" };
      const result = validator.validate(schema, data);
      expect(result.valid).toBe(true);
      expect(result.strippedArgs).toEqual(["limit", "mode"]);
      expect(data).toEqual({ query: "test" });
    });

    it("returns empty array when no unknown properties", () => {
      const validator = new Validator();
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        additionalProperties: false,
      };
      const result = validator.validate(schema, { query: "test" });
      expect(result.strippedArgs).toEqual([]);
    });

    it("does not strip when additionalProperties is not false", () => {
      const validator = new Validator();
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      };
      const data = { query: "test", extra: "value" };
      const result = validator.validate(schema, data);
      expect(result.strippedArgs).toEqual([]);
      expect(data).toHaveProperty("extra");
    });

    it("handles null and non-object data gracefully", () => {
      const validator = new Validator();
      const schema = { type: "string" };
      const result = validator.validate(schema, "hello");
      expect(result.strippedArgs).toEqual([]);
    });
  });
});

describe("use_tool repair tickets", () => {
  it("includes missing required fields in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: {} });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.missing_required).toContain("name");
    expect(repairTicket.schema_fragments).toHaveProperty("name");
  });

  it("includes type errors in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: { age: { type: "number" } },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { age: "twenty" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.type_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "age",
          expected: "number",
          got: "string",
        }),
      ]),
    );
  });

  it("includes enum violations in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed"],
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { status: "active" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.enum_violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "status",
          got: "active",
        }),
      ]),
    );
    expect(repairTicket.enum_violations[0].allowed).toEqual(["open", "closed"]);
  });

  it("includes format errors in repair_ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        start: {
          type: "string",
          format: "date-time",
        },
      },
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { start: "next Tuesday" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.format_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "start",
          expected: "date-time",
          got: "next Tuesday",
        }),
      ]),
    );
  });

  it("uses stripped args as unknown_fields", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { qurey: "hello" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.unknown_fields).toContain("qurey");
  });

  it("matches snake/camel variants via normalization", async () => {
    const schema = {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { channelId: "123" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.did_you_mean).toEqual({ channelId: "channel_id" });
  });

  it("matches close typos via Levenshtein fallback", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { qurey: "test" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.did_you_mean).toEqual({ qurey: "query" });
  });

  it("rejects distant fuzzy matches", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args: { zzzzz: "test" } });
    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.did_you_mean).toEqual({});
  });

  it("aggregates multiple error categories in one repair ticket", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        status: { type: "string", enum: ["open", "closed"] },
      },
      required: ["name"],
      additionalProperties: false,
    };

    const error = await runValidationFailure({
      schema,
      args: {
        age: "old",
        status: "active",
        emial: "test@example.com",
      },
    });

    const repairTicket = expectRepairTicket(error);
    expect(repairTicket.missing_required).toContain("name");
    expect(repairTicket.type_errors.length).toBeGreaterThan(0);
    expect(repairTicket.enum_violations.length).toBeGreaterThan(0);
    expect(repairTicket.unknown_fields).toContain("emial");
  });

  it("escalates on repeated failures with circuit breaker behavior", async () => {
    const packageId = nextId("pkg");
    const toolId = nextId("tool");
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const first = await runValidationFailure({ schema, args: {}, packageId, toolId });
    const firstTicket = expectRepairTicket(first);
    expect(firstTicket.attempt).toBe(1);
    expect(firstTicket.schema_fragments).not.toHaveProperty("__full_schema");

    const second = await runValidationFailure({ schema, args: {}, packageId, toolId });
    const secondTicket = expectRepairTicket(second);
    expect(secondTicket.attempt).toBe(2);
    expect(secondTicket.schema_fragments).toHaveProperty("__full_schema");

    const third = await runValidationFailure({ schema, args: {}, packageId, toolId });
    const thirdTicket = expectRepairTicket(third);
    expect(thirdTicket.attempt).toBe(3);
    expect(thirdTicket.schema_fragments).toHaveProperty("__full_schema");
    expect(third.message).toContain("Arguments may require user clarification");
  });

  it("caps schema_fragments to 5 entries for surgical tickets", async () => {
    const properties: Record<string, { type: string }> = {};
    const args: Record<string, string> = {};

    for (let i = 0; i < 10; i += 1) {
      const key = `field_${i}`;
      properties[key] = { type: "number" };
      args[key] = "bad";
    }

    const schema = {
      type: "object",
      properties,
      additionalProperties: false,
    };

    const error = await runValidationFailure({ schema, args });
    const repairTicket = expectRepairTicket(error);
    expect(Object.keys(repairTicket.schema_fragments).length).toBeLessThanOrEqual(5);
  });
});
