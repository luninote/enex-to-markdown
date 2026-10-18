import { md5, sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const utf8 = new TextEncoder();

export const md5Hex = (bytes: Uint8Array) => bytesToHex(md5(bytes));

export const md5Bytes = (text: string) => md5(utf8.encode(text));

export const sha1Hex = (text: string) => bytesToHex(sha1(utf8.encode(text)));
