/** Parses an inline `style` attribute into lowercase property → raw value, respecting quotes and parentheses. */
export function parseStyle(style: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!style) return out;
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const flush = (end: number) => {
    const decl = style.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) {
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl
        .slice(colon + 1)
        .replace(/!important\s*$/i, "")
        .trim();
      if (prop) out.set(prop, value);
    }
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) flush(i);
  }
  flush(style.length);
  return out;
}

/** Evernote writes its own markers both as `-en-x` (older clients) and `--en-x` (custom properties). */
export function enProp(style: Map<string, string>, name: string): string | undefined {
  return style.get(`--en-${name}`) ?? style.get(`-en-${name}`) ?? style.get(`-evernote-${name}`);
}

export function isTruthy(v: string | undefined): boolean {
  return v !== undefined && /^\s*true\s*$/i.test(v);
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  aqua: "#00ffff",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  darkred: "#8b0000",
  darkgreen: "#006400",
  darkblue: "#00008b",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
};

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla)\([\d\s.,%/]+\))$/;

/** Lowercase `#rrggbb` when the color is opaque and known; null for transparent, `inherit` and anything unsafe. */
export function cssColor(value: string | undefined, normalize: (v: string) => string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v || !SAFE_COLOR.test(v.replace(/\s+/g, " "))) return null;
  if (["transparent", "inherit", "initial", "unset", "currentcolor", "none", "auto", "windowtext"].includes(v))
    return null;
  if (/^(rgba|hsla)\(.*[,/]\s*0(\.0+)?\s*\)$/.test(v)) return null;
  const named = NAMED_COLORS[v];
  if (named) return named;
  return normalize(v);
}

/** The color part of a `background` shorthand, if it has a simple one. */
export function backgroundColor(style: Map<string, string>): string | undefined {
  const bg = style.get("background-color");
  if (bg) return bg;
  const short = style.get("background");
  if (!short || /url\(/i.test(short)) return undefined;
  const m = /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/i.exec(short);
  return m?.[1];
}

const FONT_SIZE =
  /^(\d+(\.\d+)?)(px|pt|em|rem|%)$|^(xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/;
const HTML_FONT_SIZES = ["10px", "13px", "16px", "18px", "24px", "32px", "48px"];

export function cssFontSize(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  return FONT_SIZE.test(v) ? v : null;
}

/** `<font size="1..7">` (and relative `+1`/`-1`) as CSS pixels. */
export function htmlFontSize(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  let n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  if (v.startsWith("+") || v.startsWith("-")) n = 3 + n;
  return HTML_FONT_SIZES[Math.min(7, Math.max(1, n)) - 1] ?? null;
}

/** Font family lists go into a style attribute when rendered, so anything that could end the declaration is refused. */
export function cssFontFamily(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, " ").trim();
  if (!v || v.length > 200 || /[;{}<>\\]|url\(|expression\(/i.test(v)) return null;
  return v;
}

export function cssPixels(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  return n > 0 && n < 100_000 ? n : null;
}
