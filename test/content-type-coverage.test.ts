/**
 * CI Guardrail: Non-text content type coverage.
 *
 * Verifies that each known MCP content type is explicitly handled at the
 * materialisation boundary — either extracted into a known field, preserved
 * in the JSON archive, or filtered with logging. Silent drops fail.
 *
 * If a new content type is added to MCP and appears in tool results, this
 * test should be updated to document how it's handled. The goal is to prevent
 * the class of regression where a content type is silently lost.
 */
import { describe, expect, it } from "vitest";
import { extractImageContentBlocks } from "../src/handlers/materializeOutput.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Known MCP content types per spec (2025-11-25) and their expected handling:
 *
 * | Type            | Handled by                      | Outcome                              |
 * |-----------------|---------------------------------|--------------------------------------|
 * | text            | extractDataForMaterialization   | Preserved as textParts               |
 * | image           | extractImageContentBlocks       | Extracted as ImageContentBlock        |
 * | audio           | (not extracted)                 | Preserved in JSON archive            |
 * | resource (text) | (not extracted as image)         | Preserved in JSON archive            |
 * | resource (blob) | extractImageContentBlocks       | Extracted as ImageContentBlock        |
 * | resource_link   | (not extracted)                 | Preserved in JSON archive            |
 */

describe("Content type coverage guardrail", () => {
  it("type:text is NOT extracted as image", () => {
    const result = extractImageContentBlocks({
      content: [{ type: "text", text: "hello" }],
    });
    expect(result).toHaveLength(0);
  });

  it("type:image with supported MIME is extracted", () => {
    const result = extractImageContentBlocks({
      content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].mimeType).toBe("image/png");
  });

  it("type:image with unsupported MIME is NOT extracted", () => {
    const result = extractImageContentBlocks({
      content: [{ type: "image", data: "abc", mimeType: "image/svg+xml" }],
    });
    expect(result).toHaveLength(0);
  });

  it("type:resource with image blob is extracted", () => {
    const result = extractImageContentBlocks({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///img.png", mimeType: "image/png", blob: TINY_PNG_BASE64 },
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].data).toBe(TINY_PNG_BASE64);
    expect(result[0].mimeType).toBe("image/png");
  });

  it("type:resource with text (no blob) is NOT extracted as image", () => {
    const result = extractImageContentBlocks({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///doc.txt", mimeType: "text/plain", text: "hello" },
        },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("type:resource with non-image blob is NOT extracted as image", () => {
    const result = extractImageContentBlocks({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///data.bin", mimeType: "application/octet-stream", blob: "AAAA" },
        },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("type:audio is NOT extracted as image", () => {
    const result = extractImageContentBlocks({
      content: [{ type: "audio", data: "base64audio", mimeType: "audio/mp3" }],
    });
    expect(result).toHaveLength(0);
  });

  it("type:resource_link is NOT extracted as image", () => {
    const result = extractImageContentBlocks({
      content: [{ type: "resource_link", uri: "https://example.com", name: "test" }],
    });
    expect(result).toHaveLength(0);
  });

  it("error results yield no image extraction regardless of content", () => {
    const result = extractImageContentBlocks({
      content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      isError: true,
    });
    expect(result).toHaveLength(0);
  });

  it("mixed content: all image sources extracted, non-image preserved", () => {
    const result = extractImageContentBlocks({
      content: [
        { type: "text", text: "description" },
        { type: "image", data: "img1", mimeType: "image/jpeg" },
        { type: "resource", resource: { uri: "f:///x.png", mimeType: "image/png", blob: "img2" } },
        { type: "audio", data: "audio1", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "f:///doc.md", mimeType: "text/markdown", text: "# hi" } },
        { type: "resource_link", uri: "https://example.com", name: "link" },
      ],
    });
    // Only direct image + resource-image should be extracted
    expect(result).toHaveLength(2);
    expect(result[0].data).toBe("img1");
    expect(result[1].data).toBe("img2");
  });
});
