const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short random suffix (not cryptographic; ids only need to be unique on this device). */
export function randomSuffix(len = 6): string {
  let out = "";
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.getRandomValues) {
    const buf = new Uint8Array(len);
    c.getRandomValues(buf);
    for (const b of buf) out += ALPHABET[b % ALPHABET.length];
    return out;
  }
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}-${now.toString(36)}-${randomSuffix(4)}`;
}
