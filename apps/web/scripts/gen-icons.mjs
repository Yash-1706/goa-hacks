// Generates the PNG app icons (Chrome/Android install + iOS apple-touch-icon) without any image dependency.
// Run: node apps/web/scripts/gen-icons.mjs   (outputs into apps/web/public)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const VIOLET = hex("#8b5cf6");
const CYAN = hex("#22d3ee");
const LILAC = hex("#d8ccff");

/** One pixel of the Synapse orb icon. u,v in 0..1. `scale` shrinks the artwork (maskable safe zone). */
function pixel(u, v, { maskable, scale }) {
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;
  const r = Math.hypot(x, y);
  // background: deep navy with a violet bloom top-left
  const bloom = Math.exp(-Math.hypot(u - 0.28, v - 0.18) * 3.2);
  let col = [mix(11, 36, bloom), mix(13, 27, bloom), mix(18, 69, bloom)];
  let alpha = 1;
  if (!maskable) {
    // rounded-square mask (rx = 22% of the side)
    const rx = 0.22;
    const qx = Math.abs(u - 0.5) - (0.5 - rx);
    const qy = Math.abs(v - 0.5) - (0.5 - rx);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rx;
    alpha = 1 - smooth(-0.002, 0.002, d);
  }
  // halo
  const halo = Math.exp(-Math.max(0, r - 0.2) * 7) * 0.55 * (r < 0.62 ? 1 : 0);
  col = col.map((c, i) => mix(c, mix(VIOLET[i], CYAN[i], clamp01(r * 1.6)), halo));
  // thin rings
  for (const [rad, tint, a] of [[0.347, VIOLET, 0.28], [0.289, CYAN, 0.38]]) {
    const ring = 1 - smooth(0.003, 0.009, Math.abs(r - rad));
    col = col.map((c, i) => mix(c, tint[i], ring * a));
  }
  // the orb
  const orbR = 0.219;
  const cover = 1 - smooth(orbR - 0.004, orbR + 0.004, r);
  if (cover > 0) {
    const hx = x + 0.07;
    const hy = y + 0.1;
    const hr = Math.hypot(hx, hy) / 0.42;
    let o = [mix(VIOLET[0], CYAN[0], smooth(0.05, 0.22, r)), mix(VIOLET[1], CYAN[1], smooth(0.05, 0.22, r)), mix(VIOLET[2], CYAN[2], smooth(0.05, 0.22, r))];
    o = o.map((c, i) => mix(c, LILAC[i], clamp01(1 - hr * 1.4) * 0.8));
    o = o.map((c) => mix(c, 255, clamp01(1 - hr * 3.6) * 0.9));
    col = col.map((c, i) => mix(c, o[i], cover));
  }
  return [col[0], col[1], col[2], alpha * 255];
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 2; // 2x2 supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opts);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round(a / (SS * SS));
      }
    }
  }
  return png(size, size, buf);
}

writeFileSync(join(out, "icon-192.png"), render(192, { maskable: false, scale: 1 }));
writeFileSync(join(out, "icon-512.png"), render(512, { maskable: false, scale: 1 }));
// maskable: full-bleed background, artwork inside the 80% safe zone
writeFileSync(join(out, "icon-maskable-512.png"), render(512, { maskable: true, scale: 0.78 }));
// iOS ignores transparency and rounds the corners itself: full-bleed square
writeFileSync(join(out, "apple-touch-icon.png"), render(180, { maskable: true, scale: 0.9 }));
console.log("icons written to", out);
