import type { JSONContent } from "@tiptap/core";
import { SANITIZER_VERSION } from "./sanitize.ts";

const t = (text: string, marks?: JSONContent["marks"]): JSONContent =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const p = (...content: JSONContent[]): JSONContent =>
  content.length ? { type: "paragraph", content } : { type: "paragraph" };
const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const task = (checked: boolean, ...content: JSONContent[]): JSONContent => ({
  type: "taskItem",
  attrs: { checked },
  content,
});

export const everyFeatureDoc: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [t("Trip planning")] },
    { type: "heading", attrs: { level: 2 }, content: [t("Level two")] },
    { type: "heading", attrs: { level: 3 }, content: [t("Level three")] },
    { type: "heading", attrs: { level: 4 }, content: [t("Level four")] },
    { type: "heading", attrs: { level: 5 }, content: [t("Level five")] },
    { type: "heading", attrs: { level: 6 }, content: [t("Level six")] },
    p(
      t("Plain, "),
      t("bold", [{ type: "bold" }]),
      t(", "),
      t("italic", [{ type: "italic" }]),
      t(", "),
      t("underline", [{ type: "underline" }]),
      t(", "),
      t("strike", [{ type: "strike" }]),
      t(", "),
      t("code", [{ type: "code" }]),
      t("."),
    ),
    p(t("Water is H"), t("2", [{ type: "subscript" }]), t("O, and e = mc"), t("2", [{ type: "superscript" }]), t(".")),
    { type: "paragraph", attrs: { textAlign: "center" }, content: [t("A centered line")] },
    { type: "paragraph", attrs: { textAlign: "justify", indent: 2 }, content: [t("Justified, indented twice")] },
    { type: "heading", attrs: { level: 3, textAlign: "right", indent: 1 }, content: [t("Right-aligned heading")] },
    p(
      t("A "),
      t("highlighted bold ", [{ type: "bold" }, { type: "highlight", attrs: { color: "#fff3a3" } }]),
      // Marks are listed in schema order (link, textStyle, bold, code, italic, strike, underline, highlight): the canonical JSON form.
      t("link", [
        {
          type: "link",
          attrs: { href: "https://example.org/route", target: null, rel: null, class: null, title: null },
        },
        { type: "bold" },
        { type: "highlight", attrs: { color: "#fff3a3" } },
      ]),
      t(" run", [{ type: "bold" }, { type: "highlight", attrs: { color: "#fff3a3" } }]),
      t(" then "),
      t("red serif 18px", [
        { type: "textStyle", attrs: { color: "#b03a2e", fontFamily: "Georgia, serif", fontSize: "18px" } },
      ]),
      t("."),
    ),
    p(),
    p(
      t("Line one"),
      { type: "hardBreak" },
      t("line two"),
      { type: "hardBreak" },
      { type: "hardBreak" },
      t("after two breaks"),
    ),
    p(),
    {
      type: "bulletList",
      content: [
        li(p(t("Passport")), {
          type: "bulletList",
          content: [
            li(p(t("Check expiry")), {
              type: "orderedList",
              attrs: { start: 3, type: null },
              content: [li(p(t("Deep item")))],
            }),
          ],
        }),
        li(p(t("Tickets"))),
      ],
    },
    { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(t("First"))), li(p(t("Second")))] },
    {
      type: "taskList",
      content: [
        task(true, p(t("Book hotel"))),
        task(false, p(t("Pack bags")), { type: "taskList", content: [task(false, p(t("Chargers")))] }),
      ],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: {
            checked: false,
            taskId: "4f1d2c3b-0000-4000-8000-00000000000a",
            due: "2026-11-02T09:00:00.000Z",
            flagged: true,
          },
          content: [p(t("Renew passport"))],
        },
        {
          type: "taskItem",
          attrs: { checked: true, taskId: "4f1d2c3b-0000-4000-8000-00000000000b", due: null, flagged: false },
          content: [p(t("Order currency"))],
        },
      ],
    },
    { type: "blockquote", content: [p(t("Quoted text")), p(t("Second quoted paragraph"))] },
    { type: "codeBlock", attrs: { language: "python" }, content: [t("def hello():\n    return 42")] },
    { type: "codeBlock", attrs: { language: null }, content: [t("no language")] },
    { type: "horizontalRule" },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2, rowspan: 1, colwidth: null },
              content: [p(t("Merged header"))],
            },
            { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [p(t("Cost"))] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { colspan: 1, rowspan: 2, colwidth: null }, content: [p(t("Tall cell"))] },
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(t("Flight"))] },
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [p(t("420"))] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(t("Hotel"))] },
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [p()] },
          ],
        },
      ],
    },
    p(
      t("Inline attachment "),
      {
        type: "attachment",
        attrs: {
          resourceId: "0199d3a0-0000-7000-8000-000000000001",
          display: "inline",
          mime: "image/png",
          filename: "map.png",
          width: 320,
          height: 200,
        },
      },
      t(" in text."),
    ),
    p({
      type: "attachment",
      attrs: {
        resourceId: "0199d3a0-0000-7000-8000-000000000002",
        display: "card",
        mime: "application/pdf",
        filename: "itinerary.pdf",
        width: null,
        height: null,
      },
    }),
    p(
      t("Linked web image "),
      {
        type: "image",
        attrs: { src: "https://example.org/harbor.png", alt: "Harbor at dusk", width: 240, height: 160 },
        marks: [
          {
            type: "link",
            attrs: { href: "https://example.org/harbor", target: null, rel: null, class: null, title: null },
          },
        ],
      },
      t(" and a bare one "),
      { type: "image", attrs: { src: "https://example.org/buoy.jpg", alt: null, width: null, height: null } },
    ),
    {
      type: "webClip",
      attrs: {
        html: '<div style="font-family:Georgia;padding:12px;border:1px solid #ccc"><h2 style="color:#345">Clipped article</h2><p>Some <b>clipped</b> text with <a href="https://example.org/a">a link</a>.</p></div>',
        sanitizerVersion: SANITIZER_VERSION,
      },
    },
    p(
      t("Secret: "),
      { type: "encrypted", attrs: { cipher: "AES", length: 128, hint: "the usual", ciphertext: "RU5DMA==" } },
      t(" and "),
      { type: "unsupported", attrs: { raw: '<en-xyz foo="bar">kept as is</en-xyz>' } },
    ),
    p(t("Contact someone@example.org or see www.example.org.")),
  ],
};

/** A note body as schema v1 stored it, in canonical form: checkboxes carry only `checked`, the clip only `html`. */
export const v1Doc: JSONContent = {
  type: "doc",
  content: [
    p(t("Packing")),
    {
      type: "taskList",
      content: [
        task(true, p(t("Passport"))),
        task(false, p(t("Chargers")), { type: "taskList", content: [task(false, p())] }),
      ],
    },
    p(t("Map "), {
      type: "attachment",
      attrs: {
        resourceId: "0199d3a0-0000-7000-8000-000000000001",
        display: "inline",
        mime: "image/png",
        filename: "map.png",
        width: null,
        height: null,
      },
    }),
    { type: "webClip", attrs: { html: "<p>Clipped <b>page</b></p>" } },
  ],
};

export function bigTableDoc(rows = 1000, cols = 5): JSONContent {
  const header = {
    type: "tableRow",
    content: Array.from({ length: cols }, (_, c) => ({ type: "tableHeader", content: [p(t(`Column ${c + 1}`))] })),
  };
  const body = Array.from({ length: rows }, (_, r) => ({
    type: "tableRow",
    content: Array.from({ length: cols }, (_, c) => ({
      type: "tableCell",
      content: [p(t(c === 0 ? `Row ${r + 1}` : `Value ${r + 1}.${c + 1}`))],
    })),
  }));
  return {
    type: "doc",
    content: [p(t(`Table with ${rows} rows`)), { type: "table", content: [header, ...body] }, p()],
  };
}

export function manyParagraphsDoc(count = 20000): JSONContent {
  const words = ["river", "lantern", "harbor", "maple", "ledger", "quiet", "copper", "window", "garden", "signal"];
  return {
    type: "doc",
    content: Array.from({ length: count }, (_, i) =>
      p(t(`${i + 1}. ${Array.from({ length: 12 }, (_, w) => words[(i * 7 + w * 3) % words.length]).join(" ")}`)),
    ),
  };
}

function svgBadge(i: number): string {
  const hue = (i * 37) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40" viewBox="0 0 64 40"><rect width="64" height="40" rx="6" fill="hsl(${hue},55%,60%)"/><circle cx="20" cy="20" r="10" fill="white"/><text x="36" y="25" font-size="12" fill="white">${i}</text></svg>`;
}

/** A synthetic old-style clip of about `targetBytes`: nested styled divs, inline SVG and data-URI images, tables. No network fetches. */
export function bigWebClipHtml(targetBytes = 5 * 1024 * 1024): string {
  const parts: string[] = [
    "<style>.c-card{border:1px solid #d6d0c4;margin:6px 0;padding:6px}.c-meta{color:#776;font-size:12px}</style>",
    '<div style="font-family:Verdana,sans-serif;font-size:13px;color:#222;background:#fdfcf8">',
  ];
  let size = parts.join("").length;
  let i = 0;
  while (size < targetBytes) {
    const img = `data:image/svg+xml;base64,${btoaUtf8(svgBadge(i + 1000))}`;
    const block =
      `<div class="c-card" style="padding:${4 + (i % 5)}px;background:${i % 2 ? "#f7f3ea" : "#ffffff"}">` +
      `<div style="display:flex;gap:8px;align-items:center"><div style="flex:none">${svgBadge(i)}</div>` +
      `<div style="flex:1"><div style="font-weight:bold;font-size:15px;color:#3a4a5a">Section ${i + 1}: notes on the harbor survey</div>` +
      `<div class="c-meta">Entry ${i + 1} · <a href="https://example.org/entry/${i}" onclick="steal()">permalink</a></div></div></div>` +
      `<div style="margin-left:${(i % 4) * 12}px"><div style="border-left:3px solid #c9b"><div style="padding-left:6px">` +
      `<p style="line-height:1.5">The tide tables for week ${i % 52} were copied from the ledger by lantern light. ` +
      "Copper markers line the quiet channel, and the maple pier needs a new signal window before the autumn storms. " +
      `Measurements: depth ${(i * 1.7) % 30}m, width ${(i * 3.1) % 80}m.</p>` +
      `<img src="${img}" alt="badge ${i}" width="64" height="40" style="float:right;margin:0 0 4px 8px">` +
      `<table style="border-collapse:collapse;font-size:12px"><tr><td style="border:1px solid #ccc;padding:2px 6px">Buoy</td><td style="border:1px solid #ccc;padding:2px 6px">${i}</td></tr>` +
      `<tr><td style="border:1px solid #ccc;padding:2px 6px">Status</td><td style="border:1px solid #ccc;padding:2px 6px">${i % 3 ? "ok" : "check"}</td></tr></table>` +
      '<div style="clear:both"></div></div></div></div></div>';
    parts.push(block);
    size += block.length;
    i++;
  }
  parts.push("</div>");
  return parts.join("");
}

function btoaUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function bigWebClipDoc(targetBytes = 5 * 1024 * 1024): JSONContent {
  return {
    type: "doc",
    content: [
      p(t("A large saved web page follows.")),
      { type: "webClip", attrs: { html: bigWebClipHtml(targetBytes) } },
      p(t("Text after the clip.")),
    ],
  };
}
