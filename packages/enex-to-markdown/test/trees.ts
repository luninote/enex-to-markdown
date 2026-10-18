import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every file under `dir` by its "/"-separated relative path, plus every folder (ending in "/"). */
export function readTree(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.set(`${path}/`, new Uint8Array(0));
        walk(path);
      } else out.set(path, readFileSync(join(dir, path)));
    }
  };
  walk("");
  return out;
}

export interface ZipFile {
  bytes: Uint8Array;
  /** As the ZIP stores it: MS-DOS local time, two-second steps. */
  modified: Date;
}

/**
 * The entries of a ZIP with stored (uncompressed) entries, by name; folders end in "/", and a file's parent folders
 * are listed too, as unpacking would make them. Reads Zip64 sizes and offsets.
 */
export function readZip(zip: Uint8Array): Map<string, ZipFile> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a ZIP: no end of central directory");
  let count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (view.getUint32(locator, true) !== 0x07064b50) throw new Error("Zip64 locator missing");
    const record = Number(view.getBigUint64(locator + 8, true));
    count = Number(view.getBigUint64(record + 32, true));
    at = Number(view.getBigUint64(record + 48, true));
  }
  const decoder = new TextDecoder();
  const out = new Map<string, ZipFile>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    let size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    for (let x = at + 46 + nameLength; x < at + 46 + nameLength + extraLength; ) {
      const id = view.getUint16(x, true);
      const length = view.getUint16(x + 2, true);
      if (id === 0x0001) {
        let field = x + 4;
        if (view.getUint32(at + 24, true) === 0xffffffff) field += 8;
        if (size === 0xffffffff) {
          size = Number(view.getBigUint64(field, true));
          field += 8;
        }
        if (local === 0xffffffff) local = Number(view.getBigUint64(field, true));
      }
      x += 4 + length;
    }
    if (method !== 0) throw new Error(`${name}: compression method ${method}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const modified = new Date(
      (date >> 9) + 1980,
      ((date >> 5) & 15) - 1,
      date & 31,
      time >> 11,
      (time >> 5) & 63,
      (time & 31) * 2,
    );
    out.set(name, { bytes: zip.slice(start, start + size), modified });
    const parts = name.split("/").slice(0, -1);
    for (let k = 1; k <= parts.length; k++) {
      const folder = `${parts.slice(0, k).join("/")}/`;
      if (!out.has(folder)) out.set(folder, { bytes: new Uint8Array(0), modified });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The paths that differ between two trees: missing on one side, or with other bytes. */
export function treeDiff(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string[] {
  const out: string[] = [];
  for (const [path, bytes] of a) {
    const other = b.get(path);
    if (!other) out.push(`only in the first: ${path}`);
    else if (Buffer.compare(Buffer.from(bytes), Buffer.from(other)) !== 0) out.push(`differs: ${path}`);
  }
  for (const path of b.keys()) if (!a.has(path)) out.push(`only in the second: ${path}`);
  return out;
}
