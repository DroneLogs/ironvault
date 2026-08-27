'use strict';

/**
 * Draws the Propolis mark and writes build/icon.ico (plus a 512px PNG for the
 * readme). No image libraries involved: the shapes are sampled directly and the
 * PNG and ICO containers are assembled by hand.
 *
 *   node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SAMPLES = 4; // supersampling factor per axis

/**
 * Blue and violet by default, because that is what the default palette shows
 * inside the app, and an executable whose icon does not match the window it
 * opens looks like a different program.
 *
 * Propolis is the resin bees seal the hive with, so the honey pair is the deep
 * reddish brown of the real thing rather than the gold of honey.
 */
const THEMES = {
  default: [[0x5b, 0x8d, 0xfb], [0x8f, 0x6b, 0xff]],
  amber: [[0xd5, 0x5e, 0x00], [0x6b, 0x2d, 0x0c]],
  blue: [[0x5b, 0x8d, 0xfb], [0x8f, 0x6b, 0xff]],
  green: [[0x35, 0xc4, 0x8a], [0x1f, 0x9d, 0xb4]],
  crimson: [[0xf2, 0x5f, 0x7c], [0xb0, 0x2b, 0x6a]],
  slate: [[0x7d, 0x89, 0xa3], [0x46, 0x51, 0x66]]
};

let COLOR_A = THEMES.default[0];
let COLOR_B = THEMES.default[1];

/* ------------------------------------------------------------------ shapes */

/**
 * A flat topped hexagon, the shape of a honeycomb cell.
 *
 * With circumradius R the apothem is R times root three over two, and a point
 * is inside when it sits under the flat top and behind both slanted edges.
 */
function insideHexagon(x, y, scale = 1) {
  const R = 0.47 * scale;
  const apothem = R * 0.8660254;
  const dx = Math.abs(x - 0.5);
  const dy = Math.abs(y - 0.5);
  if (dy > apothem) return false;
  return apothem * dx + (R / 2) * dy <= apothem * R;
}

function insideKeyhole(x, y) {
  const headX = 0.5;
  const headY = 0.44;
  const headR = 0.115;
  const dx = x - headX;
  const dy = y - headY;
  if (dx * dx + dy * dy <= headR * headR) return true;

  const top = 0.46;
  const bottom = 0.70;
  if (y < top || y > bottom) return false;
  const t = (y - top) / (bottom - top);
  const halfWidth = 0.048 + t * 0.040;
  return Math.abs(x - headX) <= halfWidth;
}

function pixel(u, v) {
  // u, v are 0..1 across the icon. Returns [r, g, b, a].
  if (!insideHexagon(u, v)) return [0, 0, 0, 0];

  // An inner hexagon border, the way a comb cell has a rim.
  const inner = insideHexagon(u, v, 0.86);
  if (!inner) {
    const t = Math.min(1, Math.max(0, u * 0.45 + v * 0.55));
    return [
      Math.round((COLOR_A[0] + (COLOR_B[0] - COLOR_A[0]) * t) * 0.72),
      Math.round((COLOR_A[1] + (COLOR_B[1] - COLOR_A[1]) * t) * 0.72),
      Math.round((COLOR_A[2] + (COLOR_B[2] - COLOR_A[2]) * t) * 0.72),
      255
    ];
  }

  if (insideKeyhole(u, v)) return [255, 253, 245, 255];

  const t = Math.min(1, Math.max(0, u * 0.45 + v * 0.55));
  return [
    Math.round(COLOR_A[0] + (COLOR_B[0] - COLOR_A[0]) * t),
    Math.round(COLOR_A[1] + (COLOR_B[1] - COLOR_A[1]) * t),
    Math.round(COLOR_A[2] + (COLOR_B[2] - COLOR_A[2]) * t),
    255
  ];
}

function render(size) {
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (px + (sx + 0.5) / SAMPLES) / size;
          const v = (py + (sy + 0.5) / SAMPLES) / size;
          const [pr, pg, pb, pa] = pixel(u, v);
          const weight = pa / 255;
          r += pr * weight;
          g += pg * weight;
          b += pb * weight;
          a += pa;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = a / total;
      const cover = alpha / 255;
      const offset = (py * size + px) * 4;
      data[offset] = cover ? Math.round(r / total / cover) : 0;
      data[offset + 1] = cover ? Math.round(g / total / cover) : 0;
      data[offset + 2] = cover ? Math.round(b / total / cover) : 0;
      data[offset + 3] = Math.round(alpha);
    }
  }
  return data;
}

/* --------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0);
  return Buffer.concat([length, typeBuf, payload, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------------------- ICO */

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32BE(0, at + 8);
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

/* -------------------------------------------------------------------- main */

const buildDir = path.join(__dirname, '..', 'build');
const rendererDir = path.join(__dirname, '..', 'src', 'renderer', 'icons');
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(rendererDir, { recursive: true });

for (const [name, [a, b]] of Object.entries(THEMES)) {
  COLOR_A = a;
  COLOR_B = b;
  const images = SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));
  const suffix = name === 'default' ? '' : '-' + name;

  // The .ico is what Windows uses for the window and the installer.
  fs.writeFileSync(path.join(buildDir, 'icon' + suffix + '.ico'), buildIco(images));

  // The .png is what the app draws in its own title bar and lock screen, which
  // is the icon a user actually looks at while the app is running.
  const large = encodePng(render(512), 512);
  fs.writeFileSync(path.join(rendererDir, 'app' + suffix + '.png'), large);
  if (name === 'default') fs.writeFileSync(path.join(buildDir, 'icon.png'), large);

  console.log('wrote build/icon' + suffix + '.ico and renderer app' + suffix + '.png');
}
