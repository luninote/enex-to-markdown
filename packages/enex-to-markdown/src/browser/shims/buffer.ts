import { fromBase64 } from "../../crypt.ts";

// The part of Node's Buffer the shared ENEX reader uses (UTF-8 text, base64 data, concatenation), on Uint8Array. The
// browser build injects it wherever bundled code names `Buffer`.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let scratch = new Uint8Array(1 << 16);

class ShimBuffer extends Uint8Array {
  override toString(encoding = "utf8", start = 0, end = this.length): string {
    const bytes = this.subarray(start, end);
    switch (encoding) {
      case "hex":
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      case "latin1":
      case "binary": {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return s;
      }
      default:
        return decoder.decode(bytes);
    }
  }
}

const wrap = (u8: Uint8Array) => new ShimBuffer(u8.buffer as ArrayBuffer, u8.byteOffset, u8.byteLength);

function from(
  value: string | ArrayBufferLike | ArrayLike<number>,
  encodingOrOffset?: string | number,
  length?: number,
) {
  if (typeof value === "string") {
    if (encodingOrOffset === "base64" || encodingOrOffset === "base64url") return wrap(fromBase64(value));
    if (encodingOrOffset === "latin1" || encodingOrOffset === "binary")
      return wrap(Uint8Array.from(value, (c) => c.charCodeAt(0) & 255));
    return wrap(encoder.encode(value));
  }
  if (value instanceof ArrayBuffer) {
    const offset = typeof encodingOrOffset === "number" ? encodingOrOffset : 0;
    return new ShimBuffer(value, offset, length ?? value.byteLength - offset);
  }
  const copy = new ShimBuffer((value as ArrayLike<number>).length);
  copy.set(value as ArrayLike<number>);
  return copy;
}

function byteLength(text: string | Uint8Array): number {
  if (typeof text !== "string") return text.byteLength;
  if (scratch.length < text.length * 3) scratch = new Uint8Array(text.length * 3);
  return encoder.encodeInto(text, scratch).written;
}

function concat(list: readonly Uint8Array[], total?: number): ShimBuffer {
  const out = new ShimBuffer(total ?? list.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of list) {
    if (at >= out.length) break;
    out.set(b.subarray(0, out.length - at), at);
    at += b.length;
  }
  return out;
}

export const Buffer = Object.assign(ShimBuffer, {
  from,
  alloc: (size: number) => new ShimBuffer(size),
  concat,
  byteLength,
  isBuffer: (value: unknown): value is ShimBuffer => value instanceof ShimBuffer,
});
