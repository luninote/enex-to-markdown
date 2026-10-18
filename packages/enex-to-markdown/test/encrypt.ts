import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { rc2Checks } from "../src/crypt.ts";
import { rc2EncryptEcb, rc2Keys } from "../src/rc2.ts";

/** AES text as the documented format lays it out, made here with Node's crypto. */
export function encryptAes(html: string, password: string): string {
  const salt = randomBytes(16);
  const hmacSalt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(password, salt, 50_000, 16, "sha256");
  const c = createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([Buffer.from("ENC0"), salt, hmacSalt, iv, c.update(html, "utf8"), c.final()]);
  const mac = createHmac("sha256", pbkdf2Sync(password, hmacSalt, 50_000, 16, "sha256"))
    .update(body)
    .digest();
  return Buffer.concat([body, mac]).toString("base64");
}

/** RC2 text in the older format: a 4-hex-digit CRC check, the text, NUL padding to whole blocks. */
export function encryptRc2(text: string, password: string, inverted = true): string {
  const bytes = Buffer.from(text, "utf8");
  const rest = Buffer.concat([bytes, Buffer.alloc((8 - ((bytes.length + 4) % 8)) % 8)]);
  const check = rc2Checks(rest)[inverted ? 0 : 1] as string;
  const plain = Buffer.concat([Buffer.from(check.padEnd(4, "0"), "latin1"), rest]);
  const key = createHash("md5").update(password, "utf8").digest();
  return Buffer.from(rc2EncryptEcb(rc2Keys(key, 64), plain)).toString("base64");
}
