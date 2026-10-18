import { type Editor, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { editorLabels } from "../labels.ts";
import { allowRemoteImages, onRemoteAllowed, remoteAllowed } from "../remote.ts";
import { clipResourceIds, type EditorResources, setClipResourceSrcs } from "../resources.ts";
import { cleanClipHtml, clipHasRemoteContent, clipSrcdoc, SANITIZER_VERSION, sanitizeClipHtml } from "../sanitize.ts";

export interface WebClipStats {
  sanitizeMs: number;
  iframeLoadMs: number;
  height: number;
}

export interface WebClipOptions {
  /** Called once per rendered clip after its iframe has loaded (used by the spike page for timings). */
  onRendered: ((stats: WebClipStats) => void) | null;
  /** Resolves the clip's `<img data-resource-id>` placeholders; without `fetchBlobUrl` they show their alt text. */
  resources: EditorResources | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    webClip: {
      convertWebClipToEditable: (pos: number) => ReturnType;
      /** Sanitizes raw HTML (e.g. a large paste) and inserts it as a clip at the selection. */
      insertWebClip: (html: string) => ReturnType;
    };
  }
}

// `allow-same-origin` without `allow-scripts` lets us measure the content height while nothing in it can run.
// Never add `allow-scripts` here: together with `allow-same-origin` the clip could reach the app.
const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** Fired (bubbling) on a clip's element each time its frame has loaded, so find in note can read the new page. */
export const WEB_CLIP_LOADED = "an-webclip-loaded";
const RENDER_NOW = "an-webclip-render";

/** Renders every clip under `root` now instead of when it nears the viewport (find in note reads all of them). */
export function renderWebClips(root: ParentNode): void {
  for (const el of root.querySelectorAll(".an-webclip")) el.dispatchEvent(new Event(RENDER_NOW));
}

export const WebClip = Node.create<WebClipOptions>({
  name: "webClip",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,

  addOptions: () => ({ onRendered: null, resources: null }),

  addAttributes: () => ({
    html: {
      default: "",
      parseHTML: (el: HTMLElement) => el.getAttribute("data-html") ?? "",
      renderHTML: (attrs: Record<string, unknown>) => ({ "data-html": String(attrs.html ?? "") }),
    },
    // Which SANITIZER_VERSION produced `html`; null means unknown, so the client sanitizes before rendering.
    sanitizerVersion: {
      default: null,
      validate: "number|null",
      parseHTML: (el: HTMLElement) => {
        const n = Number(el.getAttribute("data-sanitizer-version") ?? Number.NaN);
        return Number.isInteger(n) && n > 0 ? n : null;
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.sanitizerVersion === null || attrs.sanitizerVersion === undefined
          ? {}
          : { "data-sanitizer-version": String(attrs.sanitizerVersion) },
    },
  }),

  parseHTML: () => [{ tag: 'div[data-type="web-clip"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-type": "web-clip" }],
  renderText: () => "",

  addCommands() {
    return {
      convertWebClipToEditable:
        (pos) =>
        ({ state, chain }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== this.name) return false;
          const clean = cleanClipHtml(String(node.attrs.html ?? ""), node.attrs.sanitizerVersion);
          return chain()
            .insertContentAt({ from: pos, to: pos + node.nodeSize }, clean || "<p></p>")
            .run();
        },
      insertWebClip:
        (html) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { html: sanitizeClipHtml(html), sanitizerVersion: SANITIZER_VERSION },
          }),
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) =>
      new WebClipView(node, editor, getPos, this.options.onRendered, this.options.resources);
  },
});

class WebClipView {
  dom: HTMLElement;
  private iframe: HTMLIFrameElement;
  private html: string;
  private sanitizerVersion: unknown;
  private observer: IntersectionObserver | null = null;
  private resize: ResizeObserver | null = null;
  private allowRemote: boolean;
  private stopListening: () => void;
  private renderToken = 0;
  private destroyed = false;
  /** Blob URLs this view created, by resource id; null when fetching failed. */
  private blobs = new Map<string, Promise<string | null>>();
  private onRendered: WebClipOptions["onRendered"];
  private resources: EditorResources | null;

  constructor(
    node: PMNode,
    editor: Editor,
    getPos: () => number | undefined,
    onRendered: WebClipOptions["onRendered"],
    resources: EditorResources | null,
  ) {
    this.onRendered = onRendered;
    this.resources = resources;
    this.html = String(node.attrs.html ?? "");
    this.sanitizerVersion = node.attrs.sanitizerVersion;
    this.allowRemote = remoteAllowed(editor);
    this.dom = document.createElement("div");
    this.dom.className = "an-webclip";
    this.dom.contentEditable = "false";

    const bar = document.createElement("div");
    bar.className = "an-webclip__bar";
    const label = document.createElement("span");
    label.className = "an-webclip__label";
    label.textContent = editorLabels().webClipReadOnly;
    bar.append(label);
    let remote: HTMLButtonElement | null = null;
    if (!this.allowRemote && clipHasRemoteContent(this.html)) {
      remote = document.createElement("button");
      remote.type = "button";
      remote.textContent = editorLabels().loadRemoteImages;
      remote.addEventListener("click", () => allowRemoteImages(editor));
      bar.append(remote);
    }
    this.stopListening = onRemoteAllowed(editor, () => {
      this.allowRemote = true;
      remote?.remove();
      if (!this.observer) this.render();
    });
    if (editor.isEditable) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = editorLabels().webClipConvert;
      button.addEventListener("click", () => {
        const pos = getPos();
        if (typeof pos === "number") editor.chain().focus().convertWebClipToEditable(pos).run();
      });
      bar.append(button);
    }

    this.iframe = document.createElement("iframe");
    this.iframe.className = "an-webclip__frame";
    this.iframe.setAttribute("sandbox", SANDBOX);
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.title = editorLabels().webClipFrameTitle;
    this.iframe.style.cssText = "display:block;width:100%;border:0;height:160px";
    this.dom.append(bar, this.iframe);

    this.dom.addEventListener(RENDER_NOW, () => {
      if (!this.observer) return;
      this.observer.disconnect();
      this.observer = null;
      this.render();
    });

    // Large clips are sanitized and laid out only when they come near the viewport.
    if (typeof IntersectionObserver === "function") {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            this.observer?.disconnect();
            this.observer = null;
            this.render();
          }
        },
        { rootMargin: "800px" },
      );
      this.observer.observe(this.dom);
    } else {
      this.render();
    }
  }

  private render() {
    const token = ++this.renderToken;
    const t0 = performance.now();
    const clean = cleanClipHtml(this.html, this.sanitizerVersion);
    const sanitizeMs = performance.now() - t0;
    const fetchBlobUrl = this.resources?.fetchBlobUrl?.bind(this.resources);
    const ids = fetchBlobUrl ? clipResourceIds(clean) : [];
    if (!fetchBlobUrl || !ids.length) {
      this.show(clean, sanitizeMs);
      return;
    }
    for (const id of ids) {
      if (!this.blobs.has(id)) this.blobs.set(id, this.fetchBlob(fetchBlobUrl, id));
    }
    void Promise.all(ids.map(async (id) => [id, await this.blobs.get(id)] as const)).then((entries) => {
      if (token !== this.renderToken || this.destroyed) return;
      const urls = new Map(entries);
      this.show(
        setClipResourceSrcs(clean, (id) => urls.get(id)),
        sanitizeMs,
      );
    });
  }

  private async fetchBlob(fetchBlobUrl: (id: string) => Promise<string>, id: string): Promise<string | null> {
    try {
      const url = await fetchBlobUrl(id);
      if (this.destroyed) {
        URL.revokeObjectURL(url);
        return null;
      }
      return url;
    } catch {
      return null;
    }
  }

  private show(html: string, sanitizeMs: number) {
    const t1 = performance.now();
    this.iframe.onload = () => {
      const doc = this.iframe.contentDocument;
      if (!doc?.body) return;
      const measure = () => {
        const body = doc.body;
        const cs = doc.defaultView?.getComputedStyle(body);
        const margins = cs ? Number.parseFloat(cs.marginTop) + Number.parseFloat(cs.marginBottom) : 0;
        const h = Math.ceil(body.scrollHeight + margins);
        this.iframe.style.height = `${h}px`;
        return h;
      };
      const height = measure();
      this.resize?.disconnect();
      // Clip CSS sized to the viewport (height:100% plus margins) would grow the frame forever; cap the follow-ups.
      let budget = 30;
      if (typeof ResizeObserver === "function") {
        this.resize = new ResizeObserver(() => {
          if (budget-- > 0) measure();
          else this.resize?.disconnect();
        });
        this.resize.observe(doc.body);
      }
      this.onRendered?.({ sanitizeMs, iframeLoadMs: performance.now() - t1, height });
      this.dom.dispatchEvent(new Event(WEB_CLIP_LOADED, { bubbles: true }));
    };
    this.iframe.srcdoc = clipSrcdoc(html, { allowRemote: this.allowRemote });
  }

  update(node: PMNode) {
    if (node.type.name !== "webClip") return false;
    const html = String(node.attrs.html ?? "");
    if (html !== this.html || node.attrs.sanitizerVersion !== this.sanitizerVersion) {
      this.html = html;
      this.sanitizerVersion = node.attrs.sanitizerVersion;
      if (!this.observer) this.render();
    }
    return true;
  }

  stopEvent(event: Event) {
    return event.target instanceof HTMLButtonElement;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.stopListening();
    this.observer?.disconnect();
    this.resize?.disconnect();
    this.iframe.onload = null;
    for (const pending of this.blobs.values()) {
      void pending.then((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    }
    this.blobs.clear();
  }
}
