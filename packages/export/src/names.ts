// File names inside the archive: they must survive unzipping on Windows, macOS and Linux. Windows is the strictest:
// no <>:"/\|?* or control characters, no trailing dot or space, no device names (CON, NUL, COM1…), and paths
// under about 260 characters, which is why names are kept short.

const FORBIDDEN = new Set(Array.from('<>:"/\\|?*'));
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export const MAX_NAME = 80;
const MAX_BYTES = 180;

function cutAtCodePoint(s: string, maxChars: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    const b = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (out.length + ch.length > maxChars || bytes + b > MAX_BYTES) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/** A name that is safe as one path segment on every common file system. */
export function safeName(name: string, max = MAX_NAME): string {
  let s = "";
  for (const ch of name.normalize("NFC")) {
    const c = ch.codePointAt(0) as number;
    s += c < 0x20 || c === 0x7f || FORBIDDEN.has(ch) ? "_" : ch;
  }
  s = s.replace(/\s+/g, " ").trim();
  s = cutAtCodePoint(s, max)
    .replace(/[. ]+$/, "")
    .trim();
  if (!s || /^\.+$/.test(s)) s = "Untitled";
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Hands out names unique within one folder, ignoring case (Windows and macOS file systems do): "Name (2)". */
export class UniqueNames {
  private readonly taken = new Set<string>();

  take(base: string, ext = ""): string {
    const safe = safeName(base);
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? safe : `${cutAtCodePoint(safe, MAX_NAME - 6).replace(/[. ]+$/, "")} (${i})`;
      const key = `${candidate}${ext}`.toLowerCase();
      if (this.taken.has(key)) continue;
      this.taken.add(key);
      return `${candidate}${ext}`;
    }
  }
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf",
  "application/epub+zip": "epub",
  "application/json": "json",
  "application/xml": "xml",
  "text/plain": "txt",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/calendar": "ics",
  "text/vcard": "vcf",
  "text/x-vcard": "vcf",
  "message/rfc822": "eml",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/mpeg": "mpeg",
  "video/3gpp": "3gp",
};

/** The archive's one copy of an attachment's bytes, by content: `attachments/<sha256>.<ext>`. */
export function attachmentPath(sha256: string, mime: string | null | undefined): string {
  const ext = MIME_EXT[(mime ?? "").toLowerCase().split(";")[0]?.trim() ?? ""] ?? "bin";
  return `attachments/${sha256}.${ext}`;
}

/** A relative link from a file at `from` (a path inside the archive) to `to`. */
export function relativePath(from: string, to: string): string {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return [...Array.from({ length: up }, () => ".."), ...b.slice(i)].join("/");
}

/** A path as it goes into an href or a Markdown link: each segment percent-encoded, parentheses included. */
export function hrefOf(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      seg === ".." ? seg : encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/'/g, "%27"),
    )
    .join("/");
}
