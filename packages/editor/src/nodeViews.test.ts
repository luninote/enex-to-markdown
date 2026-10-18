// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactDoc } from "./content.ts";
import { createEditorExtensions, type EditorExtensionOptions } from "./extensions.ts";
import { payloadFiles } from "./fileDrop.ts";
import { fileBadge } from "./nodes/atoms.ts";
import { SANITIZER_VERSION } from "./sanitize.ts";
import { shortcutLabel } from "./shortcuts.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) if (!e.isDestroyed) e.destroy();
});

function mount(content: JSONContent, options: EditorExtensionOptions = {}): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: createEditorExtensions(options), content });
  editors.push(editor);
  return editor;
}

const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content }] });
const image = (src: string, alt: string | null = null): JSONContent => ({
  type: "image",
  attrs: { src, alt, width: 120, height: 80 },
});
const attachment = (attrs: Record<string, unknown>): JSONContent => ({
  type: "attachment",
  attrs: { resourceId: "res-1", display: "inline", mime: "image/png", filename: "map.png", ...attrs },
});
const resources = { url: (id: string) => `/files/${id}` };

describe("remote images", () => {
  it("does not fetch an http(s) image until the user allows it, then loads every one", () => {
    const editor = mount(doc(image("https://example.org/a.png", "Harbor"), image("http://example.org/b.png")));
    const root = editor.view.dom;
    expect(root.querySelectorAll<HTMLImageElement>("img:not(.ProseMirror-separator)")).toHaveLength(0);
    const placeholders = root.querySelectorAll(".an-image--blocked");
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]?.textContent).toContain("Harbor");
    expect(placeholders[0]?.textContent).toContain("example.org");

    root.querySelector<HTMLButtonElement>(".an-image__load")?.click();
    const imgs = root.querySelectorAll<HTMLImageElement>("img:not(.ProseMirror-separator)");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]?.getAttribute("src")).toBe("https://example.org/a.png");
    expect(imgs[0]?.referrerPolicy).toBe("no-referrer");
    expect(root.querySelector(".an-image--blocked")).toBeNull();
  });

  it("loads data: images directly and remote ones when the setting allows", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      mount(doc(image(data)))
        .view.dom.querySelector<HTMLImageElement>("img:not(.ProseMirror-separator)")
        ?.getAttribute("src"),
    ).toBe(data);
    const allowed = mount(doc(image("https://example.org/a.png")), { loadRemoteImages: true });
    expect(
      allowed.view.dom.querySelector<HTMLImageElement>("img:not(.ProseMirror-separator)")?.getAttribute("src"),
    ).toBe("https://example.org/a.png");
  });

  it("keeps the document unchanged", () => {
    const content = doc(image("https://example.org/a.png", "Harbor"));
    const editor = mount(content);
    editor.view.dom.querySelector<HTMLButtonElement>(".an-image__load")?.click();
    expect(compactDoc(editor.getJSON())).toEqual(content);
  });
});

describe("attachments", () => {
  it("renders inline images from the resource URL with their placement size", () => {
    const editor = mount(doc(attachment({ width: 320, height: 200 })), { resources });
    const img = editor.view.dom.querySelector<HTMLImageElement>(".an-attachment--image img");
    expect(img?.getAttribute("src")).toBe("/files/res-1");
    expect(img?.width).toBe(320);
    expect(img?.height).toBe(200);
  });

  it("renders other files, and images shown as cards, as a link that opens in a new tab", () => {
    const editor = mount(
      doc(
        attachment({ resourceId: "res-2", mime: "application/pdf", filename: "itinerary.pdf", display: "card" }),
        attachment({ resourceId: "res-3", display: "card" }),
      ),
      { resources },
    );
    const cards = editor.view.dom.querySelectorAll<HTMLAnchorElement>("a.an-attachment__card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("href")).toBe("/files/res-2");
    expect(cards[0]?.target).toBe("_blank");
    expect(cards[0]?.rel).toContain("noopener");
    expect(cards[0]?.dataset.kind).toBe("pdf");
    expect(cards[0]?.textContent).toContain("itinerary.pdf");
    expect(cards[0]?.textContent).toContain("application/pdf");
  });

  it("retries a failing image (a fresh attachment may not have synced yet), then falls back to a card", () => {
    vi.useFakeTimers();
    try {
      const editor = mount(doc(attachment({})), { resources });
      const img = () => editor.view.dom.querySelector<HTMLImageElement>("img:not(.ProseMirror-separator)");
      const outer = () => editor.view.dom.querySelector(".an-attachment");
      for (let i = 0; i < 3; i++) {
        img()?.dispatchEvent(new Event("error"));
        expect(outer()?.classList.contains("an-attachment--broken")).toBe(false);
        vi.advanceTimersByTime(10_000);
      }
      expect(img()?.getAttribute("src")).toBe("/files/res-1?retry=3");
      img()?.dispatchEvent(new Event("error"));
      expect(outer()?.classList.contains("an-attachment--broken")).toBe(true);
      expect(outer()?.querySelector("a")?.getAttribute("href")).toBe("/files/res-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a plain card without resources (Node-free preview, tests)", () => {
    const editor = mount(doc(attachment({})));
    expect(editor.view.dom.querySelector<HTMLImageElement>("img:not(.ProseMirror-separator)")).toBeNull();
    expect(editor.view.dom.querySelector("span.an-attachment__card")?.textContent).toContain("map.png");
  });

  it("labels files by extension, else by kind", () => {
    expect(fileBadge("report.docx", "document")).toBe("DOCX");
    expect(fileBadge("no-extension", "pdf")).toBe("PDF");
    expect(fileBadge(null, "other")).toBe("FILE");
  });
});

describe("web clip resources", () => {
  const clip = (html: string): JSONContent => ({
    type: "doc",
    content: [{ type: "webClip", attrs: { html, sanitizerVersion: SANITIZER_VERSION } }],
  });

  it("swaps placeholders for blob URLs before rendering and revokes them on destroy", async () => {
    let n = 0;
    const fetchBlobUrl = vi.fn(async (id: string) => `blob:http://app.test/${id}-${++n}`);
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const editor = mount(clip('<p><img data-resource-id="r1" alt="a"><img data-resource-id="r1" alt="b"></p>'), {
      resources: { ...resources, fetchBlobUrl },
    });
    const frame = editor.view.dom.querySelector("iframe");
    await vi.waitFor(() => expect(frame?.getAttribute("srcdoc")).toContain('src="blob:http://app.test/r1-1"'));
    expect(fetchBlobUrl).toHaveBeenCalledTimes(1);
    editor.destroy();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:http://app.test/r1-1"));
  });

  it("allows remote content for the clip once the editor allows it", () => {
    const editor = mount(clip('<p><img src="https://example.org/x.png"></p>'));
    const frame = editor.view.dom.querySelector("iframe");
    expect(frame?.getAttribute("srcdoc")).not.toContain("img-src data: blob: https:");
    editor.view.dom.querySelector<HTMLButtonElement>(".an-webclip__bar button")?.click();
    expect(frame?.getAttribute("srcdoc")).toContain("img-src data: blob: https:");
  });
});

describe("files", () => {
  const transfer = (files: File[], html = "") =>
    ({ files, getData: (t: string) => (t === "text/html" ? html : "") }) as unknown as DataTransfer;
  const png = new File(["x"], "shot.png", { type: "image/png" });

  it("takes files, including a copied image that comes with a bare <img>, but leaves HTML with text alone", () => {
    expect(payloadFiles(transfer([png]))).toEqual([png]);
    expect(payloadFiles(transfer([png], '<meta charset="utf-8"><img src="https://example.org/a.png">'))).toEqual([png]);
    expect(payloadFiles(transfer([png], "<p>A paragraph <img src='a.png'></p>"))).toEqual([]);
    expect(payloadFiles(transfer([], "<p>text</p>"))).toEqual([]);
    expect(payloadFiles(null)).toEqual([]);
  });
});

describe("shortcuts", () => {
  it("writes shortcuts the way each platform does", () => {
    expect(shortcutLabel("taskList", true)).toBe("⇧⌘C");
    expect(shortcutLabel("taskList", false)).toBe("Ctrl+Shift+C");
    expect(shortcutLabel("strike", true)).toBe("⌃⌘K");
    expect(shortcutLabel("horizontalRule", false)).toBe("Ctrl+Shift+-");
    expect(shortcutLabel("clearFormatting", false)).toBe("Ctrl+Shift+Space");
    expect(shortcutLabel("heading1", false)).toBe("Ctrl+Alt+1");
  });

  it("clears text formatting but keeps links", () => {
    const editor = mount({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "styled",
              marks: [
                { type: "link", attrs: { href: "https://example.org" } },
                { type: "bold" },
                { type: "highlight", attrs: { color: "#fbe3a1" } },
              ],
            },
          ],
        },
      ],
    });
    editor.chain().selectAll().clearFormatting().run();
    const marks = editor.getJSON().content?.[0]?.content?.[0]?.marks?.map((m) => m.type);
    expect(marks).toEqual(["link"]);
  });
});
