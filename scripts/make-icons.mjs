// Génère les icônes PNG (loupe blanche sur fond indigo) sans dépendance externe.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (const b of buf) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Couverture d'un pixel par la forme, estimée par sur-échantillonnage 4x4.
function coverage(x, y, size, shape) {
  let hit = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    if (shape((x + (i + 0.5) / 4) / size, (y + (j + 0.5) / 4) / size)) hit++;
  }
  return hit / 16;
}
const roundedSquare = (u, v) => {
  const r = 0.22, a = Math.max(0, Math.abs(u - 0.5) - (0.5 - r)), b = Math.max(0, Math.abs(v - 0.5) - (0.5 - r));
  return a * a + b * b <= r * r;
};
const magnifier = (u, v) => {
  const cx = 0.43, cy = 0.43, d = Math.hypot(u - cx, v - cy);
  if (d >= 0.17 && d <= 0.27) return true;
  // manche : segment de (0.62,0.62) à (0.80,0.80), demi-largeur 0.055
  const t = Math.max(0, Math.min(1, ((u - 0.62) + (v - 0.62)) / 0.36));
  const px = 0.62 + 0.18 * t, py = 0.62 + 0.18 * t;
  return Math.hypot(u - px, v - py) <= 0.055;
};

mkdirSync('icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const buf = png(size, (x, y) => {
    const bg = coverage(x, y, size, roundedSquare);
    const fg = coverage(x, y, size, magnifier);
    const r = 91 + (255 - 91) * fg, g = 108 + (255 - 108) * fg, b = 255;
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(255 * bg)];
  });
  writeFileSync(`icons/${size}.png`, buf);
}
console.log('Icônes générées dans icons/');
