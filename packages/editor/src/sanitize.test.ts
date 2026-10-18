// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clipHasRemoteContent, clipSrcdoc, sanitizeClipHtml } from "./sanitize.ts";

const dirty = [
  "<style>.x{color:red}</style>",
  '<div style="color:#123456;padding:4px" onclick="alert(1)" onmouseover="alert(2)">Hello <b>world</b></div>',
  "<script>alert(3)</script>",
  '<a href="javascript:alert(4)">bad link</a>',
  '<a href="https://example.org/ok">good link</a>',
  '<img src="data:image/png;base64,iVBORw0KGgo=" onerror="alert(5)" alt="pic" style="width:10px">',
  '<img src="https://example.org/pic.png">',
  '<svg width="10" height="10" onload="alert(6)"><rect width="10" height="10" fill="red"/></svg>',
  '<iframe src="https://example.org"></iframe>',
  '<object data="x.swf"></object><embed src="x.swf">',
  '<form action="https://example.org"><button formaction="javascript:alert(7)">go</button></form>',
  '<meta http-equiv="refresh" content="0;url=https://example.org"><base href="https://evil.example/">',
  '<a href="  JaVaScRiPt:alert(8)">mixed case</a>',
  '<iframe srcdoc="<script>alert(9)</script>"></iframe>',
].join("");

describe("sanitizeClipHtml", () => {
  const clean = sanitizeClipHtml(dirty);

  it("removes scripts, event handlers and javascript: URLs", () => {
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/\son[a-z]+\s*=/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/alert\(/);
  });

  it("removes frames, plugins, meta and base", () => {
    expect(clean).not.toMatch(/<(iframe|object|embed|meta|base)\b/i);
    expect(clean).not.toMatch(/srcdoc|formaction/i);
  });

  it("keeps text, inline styles, style blocks, images and svg", () => {
    expect(clean).toContain("Hello <b>world</b>");
    expect(clean).toContain('style="color:#123456;padding:4px"');
    expect(clean).toContain("<style>.x{color:red}</style>");
    expect(clean).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(clean).toContain('src="https://example.org/pic.png"');
    expect(clean).toMatch(/<svg[^>]*><rect/);
    expect(clean).toContain('href="https://example.org/ok"');
    expect(clean).toContain("bad link");
  });

  it("is idempotent", () => {
    expect(sanitizeClipHtml(clean)).toBe(clean);
  });

  it("wraps into a srcdoc whose CSP allows no scripts and no network unless asked", () => {
    const doc = clipSrcdoc(clean);
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/script-src|https?:(?!\/\/)/);
    expect(clipSrcdoc(clean, { allowRemote: true })).toMatch(/img-src data: blob: https: http:/);
  });

  it("detects remote references", () => {
    expect(clipHasRemoteContent('<img src="https://a.example/x.png">')).toBe(true);
    expect(clipHasRemoteContent('<div style="background:url( //a.example/x.png)">')).toBe(true);
    expect(clipHasRemoteContent("<style>@import 'x.css';</style>")).toBe(true);
    expect(
      clipHasRemoteContent('<a href="https://a.example">link only</a><img src="data:image/png;base64,AA==">'),
    ).toBe(false);
  });
});
