// XML 1.0 can't carry these at all, not even as character references: C0 controls other than tab, LF and CR,
// U+FFFE/U+FFFF, and lone surrogates. A note holding one would make the whole ENEX unreadable, so they're dropped.
export function xmlSafe(s: string): string {
  let parts: string[] | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let bad: boolean;
    if (c < 0x20) bad = c !== 0x09 && c !== 0x0a && c !== 0x0d;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      bad = true;
    } else bad = (c >= 0xdc00 && c <= 0xdfff) || c === 0xfffe || c === 0xffff;
    if (!bad) continue;
    parts ??= [];
    parts.push(s.slice(start, i));
    start = i + 1;
  }
  return parts ? parts.join("") + s.slice(start) : s;
}

export function escapeText(s: string): string {
  return xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  // Whitespace characters as references: an XML reader turns literal ones in an attribute into spaces.
  return xmlSafe(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

/** A CDATA section holding `s`; a `]]>` inside is split across two sections. */
export function cdata(s: string): string {
  return `<![CDATA[${xmlSafe(s).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function element(name: string, text: string | null | undefined): string {
  return text === null || text === undefined ? "" : `<${name}>${escapeText(text)}</${name}>`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** ENEX's date form, `yyyymmddThhmmssZ` (UTC, whole seconds). */
export function enexDate(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** ENEX form when it's exact; ISO 8601 (which our reader also accepts) when the time has milliseconds. */
export function enexDateExact(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.getUTCMilliseconds() ? d.toISOString() : enexDate(d);
}
