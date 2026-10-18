import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HAS_YARLE, YARLE } from "@luninote/enml/testing";
import { describe, expect, it } from "vitest";
import { crc32, decryptEnCrypt, decryptEnml, fromBase64 } from "../src/crypt.ts";
import { rc2DecryptEcb, rc2EncryptEcb, rc2Keys } from "../src/rc2.ts";
import { encryptAes, encryptRc2 } from "./encrypt.ts";

const hex = (s: string) => Buffer.from(s, "hex");

describe("RC2", () => {
  // RFC 2268, section 5.
  it.each([
    ["0000000000000000", 63, "0000000000000000", "ebb773f993278eff"],
    ["ffffffffffffffff", 64, "ffffffffffffffff", "278b27e42e2f0d49"],
    ["3000000000000000", 64, "1000000000000001", "30649edf9be7d2c2"],
    ["88", 64, "0000000000000000", "61a8a244adacccf0"],
    ["88bca90e90875a", 64, "0000000000000000", "6ccf4308974c267f"],
    ["88bca90e90875a7f0f79c384627bafb2", 64, "0000000000000000", "1a807d272bbe5db1"],
    ["88bca90e90875a7f0f79c384627bafb2", 128, "0000000000000000", "2269552ab0f85ca6"],
  ])("key %s, %i effective bits", (key, bits, plain, cipher) => {
    const k = rc2Keys(hex(key), bits);
    expect(Buffer.from(rc2EncryptEcb(k, hex(plain))).toString("hex")).toBe(cipher);
    expect(Buffer.from(rc2DecryptEcb(k, hex(cipher))).toString("hex")).toBe(plain);
  });

  it("computes the standard CRC32", () => {
    expect(crc32(Buffer.from("123456789")).toString(16)).toBe("cbf43926");
  });
});

describe("base64", () => {
  it("reads what Node's decoder reads: line breaks, URL-safe letters, missing or extra padding", () => {
    const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
    const b64 = bytes.toString("base64");
    for (const text of [
      b64,
      b64.replace(/(.{76})/g, "$1\r\n"),
      b64.replace(/=+$/, ""),
      `${b64}==`,
      bytes.toString("base64url"),
      ` ${b64.slice(0, 10)}\t${b64.slice(10)}`,
    ])
      expect(Buffer.from(fromBase64(text)).equals(Buffer.from(text, "base64"))).toBe(true);
  });
});

describe("decrypting <en-crypt>", () => {
  it("opens AES text with the right password and refuses a wrong one", async () => {
    const b64 = encryptAes("<div>PIN 4711 &amp; more</div>", "dog");
    expect(await decryptEnCrypt({ cipher: "AES", length: 128 }, b64, ["cat"])).toBeNull();
    expect(await decryptEnCrypt({ cipher: "AES", length: 128 }, b64, ["cat", "dog"])).toBe(
      "<div>PIN 4711 &amp; more</div>",
    );
  });

  it("refuses AES text whose ciphertext was changed, even with the right password", async () => {
    const data = Buffer.from(encryptAes("<div>secret</div>", "dog"), "base64");
    const at = 60;
    data[at] = (data[at] as number) ^ 1;
    expect(await decryptEnCrypt({ cipher: "AES", length: 128 }, data.toString("base64"), ["dog"])).toBeNull();
  });

  it("opens RC2 text, either check form, keeps it as text, and refuses a wrong password", async () => {
    const a = encryptRc2("Safe: 12 < 34\nsecond line ünïcode", "old pass");
    expect(await decryptEnCrypt({ cipher: "RC2", length: 64 }, a, ["nope"])).toBeNull();
    expect(await decryptEnCrypt({ cipher: "RC2", length: 64 }, a, ["old pass"])).toBe(
      "Safe: 12 &lt; 34<br/>second line ünïcode",
    );
    const b = encryptRc2("plain", "pw", false);
    expect(await decryptEnCrypt({ cipher: "RC2", length: 64 }, b, ["pw"])).toBe("plain");
  });

  it("replaces only the blocks a password opens and reports the hints of the others", async () => {
    const enml = `<div>A <en-crypt hint="pet" cipher="AES" length="128">${encryptAes("<b>one</b>", "dog")}</en-crypt> B <en-crypt hint="other" cipher="AES" length="128">${encryptAes("two", "fish")}</en-crypt> C</div>`;
    const r = await decryptEnml(enml, ["dog"]);
    expect(r.decrypted).toBe(1);
    expect(r.failed).toEqual(["other"]);
    expect(r.enml).toContain('A <b>one</b> B <en-crypt hint="other"');
    expect(r.enml.endsWith("</en-crypt> C</div>")).toBe(true);
  });

  it.skipIf(!HAS_YARLE)("opens a real Evernote AES block (Yarle's fixture, password from its test)", async () => {
    const enex = await readFile(join(YARLE, "encryption.enex"), "utf8");
    const r = await decryptEnml(enex, ["wrong", "password"]);
    expect(r.decrypted).toBe(1);
    expect(r.enml).toContain("This is an encrypted test");
  });
});
