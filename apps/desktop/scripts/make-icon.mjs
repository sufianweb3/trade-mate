/* global console, Buffer */
// Draws build/icon.png (1024x1024): rounded indigo tile with a white target ring and a rising line.
// Pure Node (zlib), so the icon is reproducible without design tools. electron-builder derives .ico / .icns from it.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const clamp = (v) => Math.max(0, Math.min(1, v));
const cover = (d) => clamp(0.5 - d); // signed distance (px) -> coverage, 1px anti-aliasing

function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const t = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * t, pay - bay * t);
}

const c = N / 2;
const line = [[300, 690], [440, 560], [540, 630], [730, 400]];
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const x = i + 0.5 - c, y = j + 0.5 - c;
    const tile = cover(sdRoundRect(x, y, 470, 210));
    if (tile <= 0) continue;
    // diagonal gradient indigo -> violet
    const g = clamp((i + j) / (2 * N));
    let r = 79 + (124 - 79) * g, gr = 70 + (58 - 70) * g, b = 229 + (237 - 229) * g;
    // white marks: ring and a rising line with arrow head
    const ring = cover(Math.abs(Math.hypot(x, y) - 300) - 26);
    let ln = 0;
    for (let k = 0; k < line.length - 1; k++) ln = Math.max(ln, cover(sdSegment(i, j, ...line[k], ...line[k + 1]) - 30));
    const head = Math.max(cover(sdSegment(i, j, 730, 400, 610, 410) - 30), cover(sdSegment(i, j, 730, 400, 720, 520) - 30));
    const white = Math.max(ring * 0.55, ln, head);
    r += (255 - r) * white; gr += (255 - gr) * white; b += (255 - b) * white;
    const o = (j * N + i) * 4;
    px[o] = r; px[o + 1] = gr; px[o + 2] = b; px[o + 3] = Math.round(255 * tile);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let k = n;
  for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
  return k >>> 0;
});
const crc32 = (buf) => {
  let k = 0xffffffff;
  for (const byte of buf) k = crcTable[(k ^ byte) & 0xff] ^ (k >>> 8);
  return (k ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let j = 0; j < N; j++) px.copy(raw, j * (N * 4 + 1) + 1, j * N * 4, (j + 1) * N * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);

const out = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "build", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log("icon ->", out, png.length, "bytes");
