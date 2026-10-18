// Find in note marks matches with the CSS Custom Highlight API (no DOM change, no transaction). A web clip's frame
// is its own document with its own highlight registry, so its stylesheet needs these rules too.

export const FIND_HIGHLIGHT = "luni-find";
export const FIND_CURRENT_HIGHLIGHT = "luni-find-current";

// The clip frame is always light (`.an-webclip__frame`), so these are the light values of --color-highlight,
// --color-brand and --color-text.
export const CLIP_FIND_CSS = `::highlight(${FIND_HIGHLIGHT}){background-color:#fde98a;color:#2a2a29}::highlight(${FIND_CURRENT_HIGHLIGHT}){background-color:#fdc803;color:#2a2a29}`;
