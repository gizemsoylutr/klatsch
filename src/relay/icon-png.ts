import { crc32, deflateSync } from 'node:zlib';

/**
 * The cup on a blue tile as a PNG, drawn from the same shapes as the SVG favicon: chat apps, home screens and
 * link previews that want a bitmap. No image library: shapes by distance, 4×4 samples a pixel, a plain PNG.
 */

type Shape = (x: number, y: number) => number;

const segment = (ax: number, ay: number, bx: number, by: number): Shape => (x, y) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};

/** An arc of a circle around (cx, cy), from angle a0 to a1 (radians, y down), the short way given. */
const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Shape => (x, y) => {
  const a = Math.atan2(y - cy, x - cx);
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  const inside = (angle: number) => angle >= lo - 1e-9 && angle <= hi + 1e-9;
  if (inside(a) || inside(a + 2 * Math.PI) || inside(a - 2 * Math.PI)) return Math.abs(Math.hypot(x - cx, y - cy) - r);
  const end = (t: number) => Math.hypot(x - (cx + r * Math.cos(t)), y - (cy + r * Math.sin(t)));
  return Math.min(end(a0), end(a1));
};

// The favicon's two paths, in its 32×32 box (the group is translated by 4, 3).
const ox = 4;
const oy = 3;
const STROKES: Shape[] = [
  segment(ox + 4, oy + 9, ox + 16, oy + 9),
  segment(ox + 16, oy + 9, ox + 16, oy + 14),
  arc(ox + 11, oy + 14, 5, 0, Math.PI / 2),
  segment(ox + 11, oy + 19, ox + 9, oy + 19),
  arc(ox + 9, oy + 14, 5, Math.PI / 2, Math.PI),
  segment(ox + 4, oy + 14, ox + 4, oy + 9),
  segment(ox + 16, oy + 10, ox + 17.5, oy + 10),
  arc(ox + 17.5, oy + 12.5, 2.5, -Math.PI / 2, Math.PI / 2),
  segment(ox + 17.5, oy + 15, ox + 16, oy + 15),
];
const HALF_STROKE = 1.1;

/** Inside the 32×32 tile with corners of radius 7 (`rounded` false: a full square, for icons the platform rounds). */
const inTile = (x: number, y: number, rounded: boolean) => {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  if (!rounded) return true;
  const cx = Math.min(Math.max(x, 7), 25);
  const cy = Math.min(Math.max(y, 7), 25);
  return Math.hypot(x - cx, y - cy) <= 7;
};

const cache = new Map<string, Buffer>();

export function iconPng(size = 512, rounded = true): Buffer {
  const id = `${size}:${rounded}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const blue = [0x00, 0x71, 0xe3];
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const n = 4;
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    rows[row] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let cup = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = ((px + (sx + 0.5) / n) / size) * 32;
          const y = ((py + (sy + 0.5) / n) / size) * 32;
          if (!inTile(x, y, rounded)) continue;
          tile++;
          if (STROKES.some((shape) => shape(x, y) <= HALF_STROKE)) cup++;
        }
      }
      const samples = n * n;
      const white = cup / samples;
      const alpha = tile / samples;
      const o = row + 1 + px * 4;
      for (let c = 0; c < 3; c++) {
        // Colour over the covered part only: blue mixed with white by how much of the tile is cup.
        const share = tile ? cup / tile : 0;
        rows[o + c] = Math.round(blue[c]! * (1 - share) + 255 * share);
      }
      rows[o + 3] = Math.round(255 * alpha);
      void white;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  cache.set(id, png);
  return png;
}
