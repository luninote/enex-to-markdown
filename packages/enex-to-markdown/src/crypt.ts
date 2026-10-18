import { md5Bytes } from "./hash.ts";
import { rc2DecryptEcb, rc2Keys } from "./rc2.ts";

// Text encrypted inside a note (<en-crypt>), in the two formats the published ENML documentation and open tools
// describe:
//   AES: base64 of "ENC0" + 16-byte key salt + 16-byte HMAC salt + 16-byte IV + AES-128-CBC ciphertext + 32-byte
//        HMAC-SHA256 of everything before it. Both keys are PBKDF2-HMAC-SHA256(password, salt, 50000, 16 bytes).
//        The plaintext is an ENML fragment.
//   RC2: base64 of RC2-ECB ciphertext, key = MD5(password), effective key bits = the `length` attribute (64). The
//        plaintext is 4 hex characters of a CRC32 check, then the UTF-8 text, padded with NULs to whole blocks.
// A wrong password fails the HMAC (AES) or the check (RC2), so text is never replaced with garbage.
// AES goes through WebCrypto, which Node (20 and later) and browsers both have.

const ITERATIONS = 50_000;
const MAGIC = [0x45, 0x4e, 0x43, 0x30];
const encoder = new TextEncoder();

const isAes = (data: Uint8Array) => MAGIC.every((b, i) => data[i] === b);

const nativeBase64 = (Uint8Array as unknown as { fromBase64?: (s: string, o: object) => Uint8Array }).fromBase64;

/** Base64 read as leniently as Node's decoder: whitespace and stray characters skipped, padding optional. */
export function fromBase64(text: string): Uint8Array {
  if (nativeBase64) {
    try {
      return nativeBase64(text, { lastChunkHandling: "loose" });
    } catch {
      // Characters outside the alphabet, or padding in the middle: clean up as below.
    }
  }
  let clean = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const pad = clean.indexOf("=");
  if (pad >= 0) clean = clean.slice(0, pad);
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  if (nativeBase64) return nativeBase64(clean, { lastChunkHandling: "loose" });
  const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations: ITERATIONS },
    key,
    128,
  );
  return new Uint8Array(bits);
}

export async function decryptAes(data: Uint8Array, password: string): Promise<string | null> {
  if (data.length < 4 + 16 + 16 + 16 + 16 + 32 || !isAes(data)) return null;
  const subtle = globalThis.crypto.subtle;
  const bytes = data as Uint8Array<ArrayBuffer>;
  const body = bytes.subarray(0, data.length - 32);
  const mac = bytes.subarray(data.length - 32);
  const macKey = await subtle.importKey(
    "raw",
    (await pbkdf2(password, data.subarray(20, 36))) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await subtle.verify("HMAC", macKey, mac, body))) return null;
  const key = await subtle.importKey(
    "raw",
    (await pbkdf2(password, data.subarray(4, 20))) as Uint8Array<ArrayBuffer>,
    "AES-CBC",
    false,
    ["decrypt"],
  );
  try {
    const plain = await subtle.decrypt(
      { name: "AES-CBC", iv: bytes.subarray(36, 52) },
      key,
      bytes.subarray(52, data.length - 32),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The 4-character check at the start of RC2 plaintext: the first four hex digits (no zero padding, upper case) of
 * the bitwise-inverted CRC32 of the rest. Writers differ on the inversion, so both forms are accepted.
 */
export function rc2Checks(rest: Uint8Array): string[] {
  const crc = crc32(rest);
  return [~crc >>> 0, crc].map((v) => v.toString(16).toUpperCase().slice(0, 4));
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function decryptRc2(data: Uint8Array, password: string, effectiveBits: number): string | null {
  if (!data.length || data.length % 8) return null;
  const plain = rc2DecryptEcb(rc2Keys(md5Bytes(password), effectiveBits), data);
  const head = String.fromCharCode(...plain.subarray(0, 4)).toUpperCase();
  const rest = plain.subarray(4);
  if (!rc2Checks(rest).includes(head)) return null;
  let end = rest.length;
  while (end > 0 && rest[end - 1] === 0) end--;
  try {
    return utf8.decode(rest.subarray(0, end));
  } catch {
    return null;
  }
}

export interface CryptAttrs {
  cipher: string | null;
  length: number | null;
}

/** The decrypted fragment as ENML, or null when no password opens it. */
export async function decryptEnCrypt(
  attrs: CryptAttrs,
  base64: string,
  passwords: readonly string[],
): Promise<string | null> {
  const data = fromBase64(base64.replace(/\s+/g, ""));
  const aes = isAes(data) || /^aes$/i.test(attrs.cipher ?? "");
  for (const pw of passwords) {
    if (aes) {
      const html = await decryptAes(data, pw);
      if (html !== null) return html;
      continue;
    }
    const text = decryptRc2(data, pw, attrs.length && attrs.length > 0 ? attrs.length : 64);
    // Text from the old format is usually plain; markup in it is kept as markup.
    if (text !== null) return /<\/?[a-z][^>]*>/i.test(text) ? text : textToEnml(text);
  }
  return null;
}

function textToEnml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br/>");
}

const attr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
    .exec(attrs)
    ?.slice(1)
    .find((v) => v !== undefined) ?? null;

export interface DecryptResult {
  enml: string;
  decrypted: number;
  /** Hints of the encrypted blocks no password opened ("" when a block has none). */
  failed: string[];
}

/** Replaces every <en-crypt> a password opens with its decrypted content. */
export async function decryptEnml(enml: string, passwords: readonly string[]): Promise<DecryptResult> {
  let decrypted = 0;
  const failed: string[] = [];
  if (!passwords.length || !/<en-crypt\b/i.test(enml)) return { enml, decrypted, failed };
  let out = "";
  let last = 0;
  for (const m of enml.matchAll(/<en-crypt\b([^>]*)>([\s\S]*?)<\/en-crypt\s*>/gi)) {
    const [whole, attrs = "", body = ""] = m;
    const length = Number.parseInt(attr(attrs, "length") ?? "", 10);
    const html = await decryptEnCrypt(
      { cipher: attr(attrs, "cipher"), length: Number.isFinite(length) ? length : null },
      body.replace(/<!\[CDATA\[|\]\]>/g, ""),
      passwords,
    );
    out += enml.slice(last, m.index);
    last = m.index + whole.length;
    if (html === null) {
      failed.push(attr(attrs, "hint") ?? "");
      out += whole;
      continue;
    }
    decrypted++;
    out += html;
  }
  return { enml: out + enml.slice(last), decrypted, failed };
}
