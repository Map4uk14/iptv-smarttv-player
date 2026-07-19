/**
 * Generate the launcher icons webOS requires (icon.png 80x80, largeIcon.png
 * 130x130). ares-package refuses to build without them.
 *
 * Written by hand with zlib rather than pulling in an image dependency — it is
 * a flat colour with a play triangle, and a build-time native dependency for
 * that would be a poor trade.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const BG = [0x0b, 0x0e, 0x14];
const FG = [0x4c, 0x8d, 0xff];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  // Rounded-square background with a centred play triangle.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const radius = Math.floor(size * 0.22);
  const cx = size / 2;

  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // PNG filter: none
    for (let x = 0; x < size; x++) {
      // Corner rounding.
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const outside = dx * dx + dy * dy > radius * radius;

      // Play triangle: apex right, spanning the middle ~44% of the icon.
      const tLeft = size * 0.36;
      const tRight = size * 0.70;
      const halfHeight = ((tRight - x) / (tRight - tLeft)) * (size * 0.20);
      const inTriangle = x >= tLeft && x <= tRight && Math.abs(y - cx) <= halfHeight;

      const colour = outside ? [0, 0, 0] : inTriangle ? FG : BG;
      raw[p++] = colour[0];
      raw[p++] = colour[1];
      raw[p++] = colour[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "icon.png"), makePng(80));
writeFileSync(join(OUT_DIR, "largeIcon.png"), makePng(130));
console.log("wrote icon.png (80x80) and largeIcon.png (130x130) to dist/");
