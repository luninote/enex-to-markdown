// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { docResourceIds } from "./resources.ts";
import { SANITIZER_VERSION } from "./sanitize.ts";

const a = "0199d3a0-0000-7000-8000-000000000001";
const b = "0199d3a0-0000-7000-8000-00000000000b";
const clip = (html: string, sanitizerVersion: number | null = null) => ({
  type: "doc",
  content: [{ type: "webClip", attrs: { html, sanitizerVersion } }],
});

describe("docResourceIds", () => {
  it("finds attachment nodes and clip images, once each", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "attachment", attrs: { resourceId: a } },
        { type: "webClip", attrs: { html: `<p><img data-resource-id="${b}"><img data-resource-id="${a}"></p>` } },
      ],
    };
    expect(docResourceIds(doc).sort()).toEqual([a, b].sort());
  });

  it("reads clip HTML the way the clip view renders it, whatever the markup looks like", () => {
    for (const html of [
      `<img DATA-RESOURCE-ID="${a}">`,
      `<img data-resource-id = '${a}'>`,
      `<img data-resource-id=${a}>`,
      `<img title="data-resource-id='x" data-resource-id="${a}"><p title="'">x</p>`,
      `<img data-resource-id="&Tab;${a}">`,
    ])
      expect(docResourceIds(clip(html)), html).toContain(a);
  });

  it("trusts already-sanitized clips as the view does", () => {
    expect(docResourceIds(clip(`<img data-resource-id="${a}">`, SANITIZER_VERSION))).toEqual([a]);
  });

  it("doesn't count an id that's only mentioned in text, or on another kind of node", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: `<img data-resource-id="${a}">` }] },
        { type: "image", attrs: { resourceId: b, src: "https://example.org/x.png" } },
      ],
    };
    expect(docResourceIds(doc)).toEqual([]);
  });

  it("finds an attachment however deeply it's nested", () => {
    let node: unknown = { type: "attachment", attrs: { resourceId: a } };
    for (let i = 0; i < 5000; i++) node = { type: "blockquote", content: [node] };
    expect(docResourceIds({ type: "doc", content: [node] })).toEqual([a]);
  });
});
