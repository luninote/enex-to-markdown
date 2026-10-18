// ENEX files are UTF-8, but not all of them: some are saved as UTF-16 or declare another encoding, and some mix in
// bytes from Windows-1252 (often from a tool that wrote the file). The reader only takes UTF-8, so every input passes
// through here first. Bytes that aren't valid UTF-8 are read as Windows-1252 instead of becoming "?" boxes, and
// counted, so the warnings file can say so.

export interface InputInfo {
  /** "utf-8", or the encoding the file was converted from. */
  encoding: string;
  /** Bytes that weren't valid UTF-8 and were read as Windows-1252. */
  repaired: number;
}

// Windows-1252 0x80–0x9F; the rest of 0xA0–0xFF is Latin-1. Undefined bytes stay as the control code points.
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

const encoder = new TextEncoder();
const REPLACEMENT = Array.from({ length: 256 }, (_, b) =>
  encoder.encode(String.fromCodePoint(b >= 0x80 && b < 0xa0 ? (CP1252[b - 0x80] as number) : b)),
);
const strict = new TextDecoder("utf-8", { fatal: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Length of the valid UTF-8 sequence starting at `i`, 0 when it's invalid, -1 when the buffer ends inside it. */
function sequence(buf: Uint8Array, i: number): number {
  const b = buf[i] as number;
  if (b < 0x80) return 1;
  let need: number;
  let min: number;
  if (b >= 0xc2 && b <= 0xdf) [need, min] = [2, 0x80];
  else if (b >= 0xe0 && b <= 0xef) [need, min] = [3, 0x800];
  else if (b >= 0xf0 && b <= 0xf4) [need, min] = [4, 0x10000];
  else return 0;
  let cp = b & (0xff >> (need + 1));
  for (let k = 1; k < need; k++) {
    if (i + k >= buf.length) return -1;
    const c = buf[i + k] as number;
    if ((c & 0xc0) !== 0x80) return 0;
    cp = (cp << 6) | (c & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
  return need;
}

export class Utf8Repair {
  repaired = 0;
  private carry: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array {
    const buf = this.carry.length ? concat([this.carry, chunk]) : chunk;
    this.carry = new Uint8Array(0);
    return this.fix(buf, false);
  }

  end(): Uint8Array {
    return this.carry.length ? this.fix(this.carry, true) : new Uint8Array(0);
  }

  private fix(buf: Uint8Array, last: boolean): Uint8Array {
    // Fast path: the chunk is valid UTF-8 up to a sequence the next chunk completes.
    let cut = buf.length;
    for (let k = buf.length - 1; k >= 0 && k >= buf.length - 4; k--) {
      if (((buf[k] as number) & 0xc0) !== 0x80) {
        if (sequence(buf, k) < 0) cut = k;
        break;
      }
    }
    if (!last && isUtf8(buf.subarray(0, cut))) {
      if (cut < buf.length) this.carry = buf.slice(cut);
      return buf.subarray(0, cut);
    }
    let i = 0;
    let start = 0;
    let end = buf.length;
    const parts: Uint8Array[] = [];
    while (i < buf.length) {
      const n = sequence(buf, i);
      if (n > 0) {
        i += n;
        continue;
      }
      if (n < 0 && !last) {
        this.carry = buf.slice(i);
        end = i;
        break;
      }
      parts.push(buf.subarray(start, i), REPLACEMENT[buf[i] as number] as Uint8Array);
      this.repaired++;
      i++;
      start = i;
    }
    parts.push(buf.subarray(start, end));
    return concat(parts);
  }
}

/** The encoding of a file from its byte-order mark or XML declaration ("utf-8" when neither says otherwise). */
export function sniff(start: Uint8Array): { encoding: string; skip: number } {
  if (start[0] === 0xef && start[1] === 0xbb && start[2] === 0xbf) return { encoding: "utf-8", skip: 3 };
  if (start[0] === 0xff && start[1] === 0xfe) return { encoding: "utf-16le", skip: 2 };
  if (start[0] === 0xfe && start[1] === 0xff) return { encoding: "utf-16be", skip: 2 };
  if (start[0] === 0x3c && start[1] === 0x00) return { encoding: "utf-16le", skip: 0 };
  if (start[0] === 0x00 && start[1] === 0x3c) return { encoding: "utf-16be", skip: 0 };
  const decl = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(String.fromCharCode(...start));
  const label = decl?.[1]?.toLowerCase();
  if (!label || label === "utf-8" || label === "utf8") return { encoding: "utf-8", skip: 0 };
  try {
    const known = new TextDecoder(label).encoding;
    // A declaration of UTF-16 in a file without 16-bit characters is wrong; read it as UTF-8.
    return known.startsWith("utf-16") ? { encoding: "utf-8", skip: 0 } : { encoding: known, skip: 0 };
  } catch {
    return { encoding: "utf-8", skip: 0 };
  }
}

const HEAD = 1024;

/** The file as UTF-8 chunks, whatever it was written in. `info` is complete once the chunks have ended. */
export function decodeEnex(raw: AsyncIterable<Uint8Array>): { chunks: AsyncGenerator<Uint8Array>; info: InputInfo } {
  const info: InputInfo = { encoding: "utf-8", repaired: 0 };
  async function* run(): AsyncGenerator<Uint8Array> {
    const it = raw[Symbol.asyncIterator]();
    try {
      const first: Uint8Array[] = [];
      let size = 0;
      let done = false;
      while (size < HEAD) {
        const r = await it.next();
        if (r.done) {
          done = true;
          break;
        }
        first.push(r.value);
        size += r.value.length;
      }
      const head = concat(first);
      const { encoding, skip } = sniff(head.subarray(0, HEAD));
      info.encoding = encoding;
      let step: (chunk: Uint8Array) => Uint8Array;
      let finish: () => Uint8Array;
      if (encoding === "utf-8") {
        const repair = new Utf8Repair();
        step = (c) => {
          const out = repair.push(c);
          info.repaired = repair.repaired;
          return out;
        };
        finish = () => {
          const out = repair.end();
          info.repaired = repair.repaired;
          return out;
        };
      } else {
        const decoder = new TextDecoder(encoding);
        step = (c) => encoder.encode(decoder.decode(c, { stream: true }));
        finish = () => encoder.encode(decoder.decode());
      }
      if (head.length > skip) {
        const out = step(head.subarray(skip));
        if (out.length) yield out;
      }
      while (!done) {
        const r = await it.next();
        if (r.done) break;
        const out = step(r.value);
        if (out.length) yield out;
      }
      const tail = finish();
      if (tail.length) yield tail;
    } finally {
      // Stopping early (the reader gave up on the file) must release it too.
      await it.return?.();
    }
  }
  return { chunks: run(), info };
}
