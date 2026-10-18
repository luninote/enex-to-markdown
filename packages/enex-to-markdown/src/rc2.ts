// RC2 (RFC 2268), ECB, on 8-byte blocks. Node's OpenSSL build no longer offers RC2 without the legacy provider, and
// old encrypted text in notes uses it, so it is written out here.

// The permutation of 0..255 from the digits of pi that RFC 2268 defines.
const PITABLE = Uint8Array.from(
  [
    "d9 78 f9 c4 19 dd b5 ed 28 e9 fd 79 4a a0 d8 9d",
    "c6 7e 37 83 2b 76 53 8e 62 4c 64 88 44 8b fb a2",
    "17 9a 59 f5 87 b3 4f 13 61 45 6d 8d 09 81 7d 32",
    "bd 8f 40 eb 86 b7 7b 0b f0 95 21 22 5c 6b 4e 82",
    "54 d6 65 93 ce 60 b2 1c 73 56 c0 14 a7 8c f1 dc",
    "12 75 ca 1f 3b be e4 d1 42 3d d4 30 a3 3c b6 26",
    "6f bf 0e da 46 69 07 57 27 f2 1d 9b bc 94 43 03",
    "f8 11 c7 f6 90 ef 3e e7 06 c3 d5 2f c8 66 1e d7",
    "08 e8 ea de 80 52 ee f7 84 aa 72 ac 35 4d 6a 2a",
    "96 1a d2 71 5a 15 49 74 4b 9f d0 5e 04 18 a4 ec",
    "c2 e0 41 6e 0f 51 cb cc 24 91 af 50 a1 f4 70 39",
    "99 7c 3a 85 23 b8 b4 7a fc 02 36 5b 25 55 97 31",
    "2d 5d fa 98 e3 8a 92 ae 05 df 29 10 67 6c ba c9",
    "d3 00 e6 cf e1 9e a8 2c 63 16 01 3f 58 e2 89 a9",
    "0d 38 34 1b ab 33 ff b0 bb 48 0c 5f b9 b1 cd 2e",
    "c5 f3 db 47 e5 a5 9c 77 0a a6 20 68 fe 7f c1 ad",
  ]
    .join(" ")
    .split(" ")
    .map((h) => Number.parseInt(h, 16)),
);

/** The 64 16-bit subkeys for a key and an effective key length in bits. */
export function rc2Keys(key: Uint8Array, effectiveBits: number): Uint16Array {
  if (key.length < 1 || key.length > 128) throw new Error("RC2 key must be 1 to 128 bytes");
  const t1 = Math.max(1, Math.min(1024, effectiveBits));
  const l = new Uint8Array(128);
  l.set(key);
  const t = key.length;
  for (let i = t; i < 128; i++) l[i] = PITABLE[((l[i - 1] as number) + (l[i - t] as number)) & 255] as number;
  const t8 = (t1 + 7) >> 3;
  const tm = 255 >> (8 * t8 - t1);
  l[128 - t8] = PITABLE[(l[128 - t8] as number) & tm] as number;
  for (let i = 127 - t8; i >= 0; i--) l[i] = PITABLE[(l[i + 1] as number) ^ (l[i + t8] as number)] as number;
  const k = new Uint16Array(64);
  for (let i = 0; i < 64; i++) k[i] = (l[2 * i] as number) | ((l[2 * i + 1] as number) << 8);
  return k;
}

const S = [1, 2, 3, 5];
const rol = (x: number, s: number) => ((x << s) | (x >>> (16 - s))) & 0xffff;
const ror = (x: number, s: number) => ((x >>> s) | (x << (16 - s))) & 0xffff;

function block(data: Uint8Array, at: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < 4; i++) r.push((data[at + 2 * i] as number) | ((data[at + 2 * i + 1] as number) << 8));
  return r;
}

function put(out: Uint8Array, at: number, r: number[]): void {
  for (let i = 0; i < 4; i++) {
    out[at + 2 * i] = (r[i] as number) & 255;
    out[at + 2 * i + 1] = (r[i] as number) >>> 8;
  }
}

export function rc2EncryptEcb(k: Uint16Array, data: Uint8Array): Uint8Array {
  if (data.length % 8) throw new Error("RC2 data must be whole 8-byte blocks");
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += 8) {
    const r = block(data, at);
    let j = 0;
    const mix = () => {
      for (let i = 0; i < 4; i++) {
        const a = r[(i + 3) % 4] as number;
        const b = r[(i + 2) % 4] as number;
        const c = r[(i + 1) % 4] as number;
        r[i] = ((r[i] as number) + (k[j++] as number) + (a & b) + (~a & c)) & 0xffff;
        r[i] = rol(r[i] as number, S[i] as number);
      }
    };
    const mash = () => {
      for (let i = 0; i < 4; i++) r[i] = ((r[i] as number) + (k[(r[(i + 3) % 4] as number) & 63] as number)) & 0xffff;
    };
    for (let n = 0; n < 5; n++) mix();
    mash();
    for (let n = 0; n < 6; n++) mix();
    mash();
    for (let n = 0; n < 5; n++) mix();
    put(out, at, r);
  }
  return out;
}

export function rc2DecryptEcb(k: Uint16Array, data: Uint8Array): Uint8Array {
  if (data.length % 8) throw new Error("RC2 data must be whole 8-byte blocks");
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += 8) {
    const r = block(data, at);
    let j = 63;
    const mix = () => {
      for (let i = 3; i >= 0; i--) {
        r[i] = ror(r[i] as number, S[i] as number);
        const a = r[(i + 3) % 4] as number;
        const b = r[(i + 2) % 4] as number;
        const c = r[(i + 1) % 4] as number;
        r[i] = ((r[i] as number) - (k[j--] as number) - (a & b) - (~a & c)) & 0xffff;
      }
    };
    const mash = () => {
      for (let i = 3; i >= 0; i--) r[i] = ((r[i] as number) - (k[(r[(i + 3) % 4] as number) & 63] as number)) & 0xffff;
    };
    for (let n = 0; n < 5; n++) mix();
    mash();
    for (let n = 0; n < 6; n++) mix();
    mash();
    for (let n = 0; n < 5; n++) mix();
    put(out, at, r);
  }
  return out;
}
