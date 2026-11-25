// A QR code for one link: byte mode, level M, versions 1 to 10. No dependencies.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
//
// Open3DPC needs its own reader; a phone's camera app opens a link only from a QR code.

// Level M, versions 1 to 10: error words per block, then [blocks, data words per block] groups.
const BLOCKS = [
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = EXP[i + 255] = x; LOG[x] = i; x = (x << 1) ^ (x & 128 ? 0x11d : 0); }
const times = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function errorWords(data, count) {
  let generator = [1];
  for (let i = 0; i < count; i++) {
    const next = [...generator, 0];
    generator.forEach((g, j) => { next[j + 1] ^= times(g, EXP[i]); });
    generator = next;
  }
  const rest = [...data, ...Array(count).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = rest[i];
    if (factor) generator.forEach((g, j) => { rest[i + j] ^= times(g, factor); });
  }
  return rest.slice(data.length);
}

function bch(value, generator, shift) {
  let rest = value << shift;
  for (let bit = 31 - Math.clz32(rest); bit >= shift; bit--) if (rest & (1 << bit)) rest ^= generator << (bit - shift);
  return (value << shift) | rest;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => ((r >> 1) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  let dark = 0;
  const lines = [...grid.map((row) => row.join('')), ...grid.map((_, c) => grid.map((row) => row[c]).join(''))];
  for (const line of lines) {
    for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
    for (let i = 0; i + 11 <= size; i++) if (['10111010000', '00001011101'].includes(line.slice(i, i + 11))) score += 40;
  }
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    dark += grid[r][c];
    if (r && c && grid[r][c] === grid[r - 1][c] && grid[r][c] === grid[r][c - 1] && grid[r][c] === grid[r - 1][c - 1]) score += 3;
  }
  return score + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

/** Rows of 0 and 1, without the four-module quiet zone. */
export function qr(text) {
  const bytes = new TextEncoder().encode(text);
  const capacity = (groups) => groups.reduce((n, [blocks, words]) => n + blocks * words, 0);
  const index = BLOCKS.findIndex(([, ...groups], i) => bytes.length * 8 + 4 + (i < 9 ? 8 : 16) <= capacity(groups) * 8);
  if (index < 0) throw new RangeError('The link is too long.');
  const version = index + 1;
  const size = 17 + 4 * version;
  const [errorCount, ...groups] = BLOCKS[index];
  const total = capacity(groups);

  let bits = '0100' + bytes.length.toString(2).padStart(version < 10 ? 8 : 16, '0');
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  bits += '0'.repeat(Math.min(4, total * 8 - bits.length));
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const words = bits.match(/.{8}/g).map((b) => parseInt(b, 2));
  for (let pad = 0xec; words.length < total; pad ^= 0xec ^ 0x11) words.push(pad);

  const blocks = [];
  for (const [count, length] of groups) for (let i = 0; i < count; i++) blocks.push(words.splice(0, length));
  const errors = blocks.map((block) => errorWords(block, errorCount));
  const interleave = (lists) => Array.from({ length: Math.max(...lists.map((l) => l.length)) }, (_, i) => lists.filter((l) => i < l.length).map((l) => l[i])).flat();
  const stream = [...interleave(blocks), ...interleave(errors)].map((w) => w.toString(2).padStart(8, '0')).join('');

  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const square = (r, c, reach, dark) => {
    for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++)
      if (grid[r + y]?.[c + x] !== undefined) grid[r + y][c + x] = dark(Math.max(Math.abs(x), Math.abs(y))) ? 1 : 0;
  };
  for (const [r, c] of [[3, 3], [3, size - 4], [size - 4, 3]]) square(r, c, 4, (d) => d < 2 || d === 3);
  for (const r of ALIGN[index]) for (const c of ALIGN[index]) if (grid[r][c] === null) square(r, c, 2, (d) => d !== 1);
  for (let i = 8; i < size - 8; i++) { grid[6][i] = 1 - (i % 2); grid[i][6] = 1 - (i % 2); }
  const formatCells = (value) => {
    for (let i = 0; i < 15; i++) {
      const bit = (value >> i) & 1;
      grid[i < 6 ? i : i < 8 ? i + 1 : size - 15 + i][8] = bit;
      grid[8][i < 8 ? size - 1 - i : i < 9 ? 7 : 14 - i] = bit;
    }
    grid[size - 8][8] = 1;
  };
  formatCells(0);
  if (version > 6) {
    const value = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const at = [Math.floor(i / 3), size - 11 + (i % 3)];
      grid[at[0]][at[1]] = grid[at[1]][at[0]] = (value >> i) & 1;
    }
  }
  const fixed = grid.map((row) => row.map((cell) => cell !== null));
  let offset = 0;
  let up = true;
  for (let right = size - 1; right > 0; right -= 2, up = !up) {
    if (right === 6) right--;
    for (let i = 0; i < size; i++) for (const c of [right, right - 1]) {
      const r = up ? size - 1 - i : i;
      if (!fixed[r][c]) grid[r][c] = stream[offset++] === '1' ? 1 : 0;
    }
  }
  const plain = grid.map((row) => row.slice());
  let best = null;
  MASKS.forEach((mask, number) => {
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fixed[r][c]) grid[r][c] = plain[r][c] ^ (mask(r, c) ? 1 : 0);
    formatCells(bch(number, 0x537, 10) ^ 0x5412); // level M is 00
    const score = penalty(grid);
    if (!best || score < best.score) best = { score, rows: grid.map((row) => row.slice()) };
  });
  return best.rows;
}

/** An SVG with the quiet zone. */
export function qrSvg(text, label = 'QR code') {
  const rows = qr(text);
  const side = rows.length + 8;
  const path = rows.map((row, r) => row.map((dark, c) => (dark ? `M${c + 4} ${r + 4}h1v1h-1z` : '')).join('')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="${label}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${side}v${side}H0z"/><path d="${path}"/></svg>`;
}
