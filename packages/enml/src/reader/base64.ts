/**
 * Decodes base64 that arrives in arbitrary pieces (XML text events), never holding more than one piece.
 * Whitespace is ignored; any other non-alphabet character is skipped and flagged, so damaged data is
 * reported instead of silently shortening the file.
 */
export class Base64StreamDecoder {
  private carry = "";
  invalid = 0;
  private done = false;

  push(text: string): Buffer | null {
    if (this.done) {
      if (/[A-Za-z0-9+/]/.test(text)) this.invalid += text.length;
      return null;
    }
    let clean = text.replace(/[\s]+/g, "");
    if (/[^A-Za-z0-9+/=]/.test(clean)) {
      const before = clean.length;
      clean = clean.replace(/[^A-Za-z0-9+/=]/g, "");
      this.invalid += before - clean.length;
    }
    if (!clean) return null;
    const pad = clean.indexOf("=");
    if (pad >= 0) {
      // Padding ends the data. Anything after it (other than more padding) is not part of this resource.
      const rest = clean.slice(pad).replace(/^=+/, "");
      if (rest) this.invalid += rest.length;
      this.done = true;
      const all = this.carry + clean.slice(0, pad);
      this.carry = "";
      return decodeTail(all, this);
    }
    const all = this.carry + clean;
    const usable = all.length - (all.length % 4);
    this.carry = all.slice(usable);
    return usable ? Buffer.from(all.slice(0, usable), "base64") : null;
  }

  end(): Buffer | null {
    if (this.done) return null;
    this.done = true;
    const tail = this.carry;
    this.carry = "";
    return tail ? decodeTail(tail, this) : null;
  }
}

function decodeTail(all: string, d: Base64StreamDecoder): Buffer {
  const rem = all.length % 4;
  if (rem === 1) {
    // One leftover character cannot encode a byte.
    d.invalid += 1;
    return Buffer.from(all.slice(0, -1), "base64");
  }
  return Buffer.from(all, "base64");
}
