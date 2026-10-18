import { getStyleProperty } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Color } from "@tiptap/extension-text-style";

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/**
 * Browsers serialize inline colors as rgb(), and ENML uses both forms, so a color would change its
 * string form on every copy/paste. Stored colors are lowercase #rrggbb when opaque; anything else is kept as given.
 */
export function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/['"]+/g, "").trim().toLowerCase();
  if (!v) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(v);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1);
    if (alpha >= 1) return `#${hex2(Number(rgb[1]))}${hex2(Number(rgb[2]))}${hex2(Number(rgb[3]))}`;
  }
  return v;
}

export interface PaletteColor {
  name: string;
  /** Stored in the document; the light-theme value of a design token. The app's CSS maps it to the token, so it follows dark mode. */
  value: string;
}

export const TEXT_COLORS: readonly PaletteColor[] = [
  { name: "Red", value: "#a1251b" },
  { name: "Orange", value: "#8f4510" },
  { name: "Amber", value: "#875000" },
  { name: "Green", value: "#22633f" },
  { name: "Blue", value: "#22507d" },
  { name: "Grey", value: "#575e69" },
];

export const HIGHLIGHT_COLORS: readonly PaletteColor[] = [
  { name: "Yellow", value: "#fbe3a1" },
  { name: "Sand", value: "#f7e6c4" },
  { name: "Peach", value: "#fbe9d6" },
  { name: "Rose", value: "#fbe5e2" },
  { name: "Mint", value: "#e3f0e7" },
  { name: "Sky", value: "#e2ecf5" },
];

export const DEFAULT_HIGHLIGHT = "#fbe3a1";

// Attrs can come from synced JSON, not only from parsed HTML: never let a value break out of the declaration.
const safeCss = (v: unknown): v is string => typeof v === "string" && /^[#a-z0-9(),.%\s/-]+$/i.test(v);

export const TextColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (el: HTMLElement) => normalizeColor(getStyleProperty(el, "color") ?? el.style.color),
            // data-text-color lets the app's CSS recognize palette colors: the browser rewrites the style as rgb().
            renderHTML: (attrs: Record<string, unknown>) =>
              safeCss(attrs.color) ? { style: `color: ${attrs.color}`, "data-text-color": attrs.color } : {},
          },
        },
      },
    ];
  },
});

export const HighlightColor = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          normalizeColor(
            el.getAttribute("data-color") ?? getStyleProperty(el, "background-color") ?? el.style.backgroundColor,
          ),
        renderHTML: (attrs: Record<string, unknown>) =>
          safeCss(attrs.color)
            ? { "data-color": attrs.color, style: `background-color: ${attrs.color}; color: inherit` }
            : {},
      },
    };
  },
}).configure({ multicolor: true });
