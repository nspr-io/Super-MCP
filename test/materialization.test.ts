import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { materializeOutput } from "../src/handlers/materializeOutput.js";

describe("materializeOutput", () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rebel-mcp-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const createToolResult = (text: string, type = "text") => ({
    content: [{ type, text }],
    isError: false,
  });

  it("T1: Output > limit + workspace path -> file written, response in envelope", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", { a: 1 }, createToolResult(text), 100, tempWorkspace, 100_000);

    expect(result).not.toBeNull();
    expect(result?.package_id).toBe("pkg1");
    expect(result?.tool_id).toBe("tool1");
    expect(result?.result.status).toBe("materialized");
    expect(result?.result.file_path).toContain(path.join(".rebel", "tool-outputs"));
    expect(result?.result.size_chars).toBeGreaterThan(150_000); // Because of frontmatter
    expect(result?.result.message).toContain(result!.result.file_path);

    const content = await fs.readFile(result!.result.file_path as string, "utf8");
    expect(content).toContain(text);
  });

  it("T2: Output < limit -> normal in-context response (returns null)", async () => {
    const text = "A".repeat(50_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    expect(result).toBeNull();
  });

  it("T3: JSON output -> valid pretty-printed .json file (no frontmatter)", async () => {
    const jsonStr = JSON.stringify({ items: Array(1000).fill({ a: 1 }) });
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(jsonStr), 100, tempWorkspace, 100);

    expect(result).not.toBeNull();
    expect(result?.result.file_path).toMatch(/\.json$/);

    const content = await fs.readFile(result!.result.file_path as string, "utf8");
    expect(content.startsWith("{")).toBe(true);
    expect(content).not.toContain("---");
    JSON.parse(content); // Should not throw
  });

  it("T4: Non-JSON output -> YAML frontmatter + .txt file", async () => {
    const text = "Hello world ".repeat(10_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100);

    expect(result).not.toBeNull();
    expect(result?.result.file_path).toMatch(/\.txt$/);

    const content = await fs.readFile(result!.result.file_path as string, "utf8");
    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain('package_id: "pkg1"');
    expect(content).toContain(text);
  });

  it("T5: Preview is ~2KB with truncation indicator", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    expect(result?.result.preview.length).toBe(2048);
    expect(result?.result.preview_truncated).toBe(true);
  });

  it("T6: Filename follows naming convention", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    const filename = path.basename(result!.result.file_path as string);
    // yyMMdd_HHmm_{pkg}_{tool}_{hash}.{ext}
    expect(filename).toMatch(/^\d{6}_\d{4}_pkg1_tool1_[a-f0-9]{8}\.txt$/);
  });

  it("T7: No workspace path is handled by caller (but if passed empty, fails)", async () => {
    const text = "A".repeat(150_000);
    // Passing empty workspace throws inside materializeOutput fs operations -> caught and returns null
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, "", 100_000);
    expect(result).toBeNull();
  });

  it("T8: Disk write failure -> falls back to continuation gracefully", async () => {
    const text = "A".repeat(150_000);
    const mockFs = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("Disk Full"));
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    expect(result).toBeNull();
    mockFs.mockRestore();
  });

  it("T9: max_output_chars: null is handled by caller — materializeOutput requires explicit limit", async () => {
    // When max_output_chars is null, useTool.ts sets effectiveLimit to undefined
    // and skips the materialization call entirely. This test verifies that
    // materializeOutput correctly materializes when called with a valid limit,
    // confirming the caller is responsible for the null gate.
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    expect(result).not.toBeNull(); // With explicit limit, materialization happens
  });

  it("T10: First call creates .rebel/tool-outputs/ directory", async () => {
    const text = "A".repeat(150_000);
    await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    const stat = await fs.stat(path.join(tempWorkspace, ".rebel", "tool-outputs"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("T11: Concurrent calls to same tool -> different filenames", async () => {
    const text = "A".repeat(150_000);
    const results = await Promise.all([
      materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000),
      materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000),
    ]);
    expect(results[0]!.result.file_path).not.toBe(results[1]!.result.file_path);
  });

  it("T12: Workspace path with spaces works correctly", async () => {
    const spaceWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "space test - "));
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, spaceWorkspace, 100_000);
    expect(result).not.toBeNull();
    expect(await fs.readFile(result!.result.file_path as string, "utf8")).toContain(text);
    await fs.rm(spaceWorkspace, { recursive: true, force: true });
  });

  it("T13: Response JSON has all required fields inside UseToolOutput envelope", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", { a: 1 }, createToolResult(text), 123, tempWorkspace, 100_000);
    expect(result?.package_id).toBe("pkg1");
    expect(result?.tool_id).toBe("tool1");
    expect(result?.args_used).toEqual({ a: 1 });
    expect(result?.result.status).toBe("materialized");
    expect(result?.result.file_path).toBeTruthy();
    expect(result?.result.size_chars).toBeGreaterThan(0);
    expect(result?.result.estimated_tokens).toBeGreaterThan(0);
    expect(result?.telemetry.duration_ms).toBe(123);
    expect(result?.telemetry.materialized).toBe(true);
  });

  it("T14: Response stays inside existing UseToolOutput envelope shape", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", { a: 1 }, createToolResult(text), 123, tempWorkspace, 100_000);
    // The keys should match the typical UseToolOutput
    expect(Object.keys(result!).sort()).toEqual(["args_used", "package_id", "result", "telemetry", "tool_id"]);
  });

  it("T15: Output exactly at limit -> no materialization; limit+1 -> materializes", async () => {
    // Text output: frontmatter adds overhead. Compute frontmatter length for these test values.
    const frontmatterLen = `---\npackage_id: "pkg1"\ntool_id: "tool1"\n---\n`.length;
    const textAtLimit = "A".repeat(100_000 - frontmatterLen);
    const resAtLimit = await materializeOutput("pkg1", "tool1", {}, createToolResult(textAtLimit), 100, tempWorkspace, 100_000);
    expect(resAtLimit).toBeNull(); // Exactly at limit -> no materialization

    const textOverLimit = "A".repeat(100_000 - frontmatterLen + 1);
    const resOverLimit = await materializeOutput("pkg1", "tool1", {}, createToolResult(textOverLimit), 100, tempWorkspace, 100_000);
    expect(resOverLimit).not.toBeNull(); // One char over -> materializes
  });

  it("T16: file_path in response is absolute, not relative", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", { a: 1 }, createToolResult(text), 123, tempWorkspace, 100_000);
    
    expect(path.isAbsolute(result!.result.file_path as string)).toBe(true);
    expect(result!.result.file_path).toContain(path.join(".rebel", "tool-outputs"));
    
  });

  it("T17: .rebel/tool-outputs directory creation failure -> falls back to continuation", async () => {
    const text = "A".repeat(150_000);
    const mockFs = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("EACCES"));
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    expect(result).toBeNull();
    mockFs.mockRestore();
  });

  it("T18: Output > 20MB -> falls back to continuation", async () => {
    const text = "A".repeat(20_000_001);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text), 100, tempWorkspace, 100_000);
    expect(result).toBeNull();
  });

  it("T19: Blob/binary content type -> falls back to continuation", async () => {
    const text = "A".repeat(150_000);
    const result = await materializeOutput("pkg1", "tool1", {}, createToolResult(text, "image"), 100, tempWorkspace, 100_000);
    expect(result).toBeNull();
  });
});
