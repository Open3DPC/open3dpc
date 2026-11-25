// The images the Swift and Kotlin readers decode in their tests. `node test/fixtures.js` rewrites them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode, raster } from '../open3dpc.js';

export const directory = fileURLToPath(new URL('../../spec/fixtures/', import.meta.url));
const numbers = [1, 600, 4242, 9999].map((n) => n.toString(2).padStart(14, '0'));
export const cases = [
  ...numbers.map((payload, i) => ({ name: `number-${[1, 600, 4242, 9999][i]}-4x6`, payload, h: 4, w: 6 })),
  { name: 'number-9999-6x4', payload: numbers[3], h: 6, w: 4 },
  { name: 'bits9-3x5', payload: '010011011', h: 3, w: 5 },
  { name: 'bits9-4x4', payload: '010011011', h: 4, w: 4 },
  { name: 'bits9-2x7', payload: '101100111', h: 2, w: 7 },
  { name: 'bits38-10x5', payload: '10110011100011110000101100111000111100', h: 10, w: 5 },
  { name: 'bits88-10x10', payload: '1011001110001111'.repeat(5) + '10110011', h: 10, w: 10 },
];

/** A printed code as a camera would frame it: the code on a wide light field, never edge to edge. */
export function picture({ payload, h, w }) {
  const code = encode(payload, h, w);
  const inner = raster(code, { scale: 12 });
  const margin = 96;
  const width = inner.width + 2 * margin;
  const height = inner.height + 2 * margin;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < inner.height; y++)
    pixels.set(inner.pixels.subarray(y * inner.width, (y + 1) * inner.width), (y + margin) * width + margin);
  return { width, height, pixels };
}
export const manifest = () => JSON.stringify(cases.map(({ name, payload, h, w }) => ({ file: `${name}.pgm`, payload, h, w })), null, 1) + '\n';
export const pgm = ({ width, height, pixels }) => Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(directory, { recursive: true });
  for (const item of cases) writeFileSync(`${directory}${item.name}.pgm`, pgm(picture(item)));
  writeFileSync(`${directory}manifest.json`, manifest());
}
