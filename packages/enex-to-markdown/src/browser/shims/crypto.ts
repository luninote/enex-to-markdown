import { md5, sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Buffer } from "./buffer.ts";

// node:crypto's createHash, for the shared ENEX reader, which hashes every attachment as it streams: MD5 (how a note
// names its attachments) and SHA-256. The converter never reads the SHA-256, and in JavaScript it would take about a
// third of the browser's conversion time, so here it isn't computed: its digest is empty.

const ALGORITHMS = { md5, sha1 };
const encoder = new TextEncoder();

export interface Hash {
  update(data: string | Uint8Array): Hash;
  digest(): Uint8Array;
  digest(encoding: "hex"): string;
}

const skipped: Hash = {
  update: () => skipped,
  digest: ((encoding?: "hex") => (encoding === "hex" ? "" : Buffer.alloc(0))) as Hash["digest"],
};

export function createHash(algorithm: string): Hash {
  if (algorithm === "sha256") return skipped;
  const make = ALGORITHMS[algorithm as keyof typeof ALGORITHMS];
  if (!make) throw new Error(`Hash ${algorithm} isn't available in the browser build`);
  const h = make.create();
  const hash = {
    update(data: string | Uint8Array) {
      h.update(typeof data === "string" ? encoder.encode(data) : data);
      return hash;
    },
    digest(encoding?: "hex") {
      const d = h.digest();
      return encoding === "hex" ? bytesToHex(d) : Buffer.from(d);
    },
  };
  return hash as Hash;
}
