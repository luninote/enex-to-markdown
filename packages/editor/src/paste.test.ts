import { describe, expect, it } from "vitest";
import { bigWebClipHtml } from "./fixtures.ts";
import { isLargePaste, LARGE_PASTE_THRESHOLD } from "./paste.ts";

describe("isLargePaste", () => {
  it("parses anything up to the threshold and offers a clip above it", () => {
    expect(LARGE_PASTE_THRESHOLD).toBe(512 * 1024);
    expect(isLargePaste("x".repeat(LARGE_PASTE_THRESHOLD))).toBe(false);
    expect(isLargePaste("x".repeat(LARGE_PASTE_THRESHOLD + 1))).toBe(true);
  });

  it("treats a missing or empty HTML flavor (plain-text paste) as small", () => {
    expect(isLargePaste("")).toBe(false);
    expect(isLargePaste(null)).toBe(false);
    expect(isLargePaste(undefined)).toBe(false);
  });

  it("honors a custom threshold", () => {
    expect(isLargePaste("<p>hello</p>", 5)).toBe(true);
    expect(isLargePaste("<p>hello</p>", 100)).toBe(false);
  });

  it("sends a saved web page to the clip path and an ordinary copied article to the parser", () => {
    expect(isLargePaste(bigWebClipHtml(5 * 1024 * 1024))).toBe(true);
    expect(isLargePaste(bigWebClipHtml(100 * 1024))).toBe(false);
  });
});
