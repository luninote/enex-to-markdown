// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clipResourceIds, setClipResourceSrcs } from "./resources.ts";
import { sanitizeClipHtml } from "./sanitize.ts";

describe("clip resource placeholders", () => {
  const html =
    '<p>Scan <img data-resource-id="r1" alt="scan.png" width="300"> and again <img alt="x" data-resource-id="r1">' +
    ' <img data-src="keep" data-resource-id="r&amp;2" src="https://tracker.example/p.gif"> ' +
    '<img src="data:image/png;base64,AAAA" alt="inline"> <span data-resource-id="r3">[report.pdf]</span></p>';

  it("lists distinct image resource ids in order, decoding entities", () => {
    expect(clipResourceIds(html)).toEqual(["r1", "r&2"]);
    expect(clipResourceIds("<p>none</p>")).toEqual([]);
  });

  it("points placeholders at the given source and drops any other src", () => {
    const out = setClipResourceSrcs(html, (id) => (id === "r1" ? "blob:http://app.test/1" : undefined));
    expect(out.match(/src="blob:http:\/\/app\.test\/1"/g)).toHaveLength(2);
    // An unresolved placeholder loses its src entirely: nothing is fetched for it.
    expect(out).not.toContain("tracker.example");
    expect(out).toContain('data-src="keep"');
    // Images that are not placeholders are untouched.
    expect(out).toContain('<img src="data:image/png;base64,AAAA" alt="inline">');
    expect(out).toContain('<span data-resource-id="r3">');
  });

  it("escapes the inserted URL", () => {
    const out = setClipResourceSrcs('<img data-resource-id="a">', () => 'blob:x"onerror="y');
    expect(out).toBe('<img src="blob:x&quot;onerror=&quot;y" data-resource-id="a">');
  });

  it("works on sanitizer output", () => {
    const clean = sanitizeClipHtml(
      "<div><img data-resource-id='r9' alt='a \"quoted\" name' onerror='alert(1)'></div>",
      window as unknown as Parameters<typeof sanitizeClipHtml>[1],
    );
    expect(clipResourceIds(clean)).toEqual(["r9"]);
    const out = setClipResourceSrcs(clean, () => "blob:http://app.test/9");
    const doc = new DOMParser().parseFromString(out, "text/html");
    const img = doc.querySelector("img");
    expect(img?.getAttribute("src")).toBe("blob:http://app.test/9");
    expect(img?.getAttribute("alt")).toBe('a "quoted" name');
    expect(img?.hasAttribute("onerror")).toBe(false);
  });
});
