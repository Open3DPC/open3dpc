// Open3DPC v2 in the browser and in Node: encoding, SVG, PNG and STL. No dependencies.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

export const DEFAULT_MODULE_MM = 1.6;
export const DEFAULT_MATERIAL_HEIGHT_MM = 0.6;
export const MAX_CRC_WIDTH = 10;
export const COMPACT_MAX = 10;
export const FULL_POLYNOMIALS = Object.freeze({
  1: 0x3, 2: 0x7, 3: 0xb, 4: 0x13, 5: 0x25, 6: 0x67, 7: 0xcb, 8: 0x107, 9: 0x2fb, 10: 0x48f,
});

// ---------------------------------------------------------------- geometry, v2.md §4

export function crcWidth(h) {
  if (!Number.isInteger(h) || h < 1) throw new RangeError('Matrix height must be a positive integer.');
  return Math.min(h, MAX_CRC_WIDTH);
}
export const dataRegionLength = (h, w) => h * w - crcWidth(h) - 1;
export const payloadCapacity = (h, w) => dataRegionLength(h, w) - 1;
export const isValidGeometry = (h, w) =>
  Number.isInteger(h) && Number.isInteger(w) && h >= 1 && w >= 1 && payloadCapacity(h, w) >= 2 * crcWidth(h);
export const physicalSize = (h, w, module = DEFAULT_MODULE_MM) => ({
  width: (w + 2) * module, height: (h + 2) * module,
  quietWidth: (w + 3) * module, quietHeight: (h + 3) * module,
});

/** Geometries that hold `bits` payload bits with at most `maximumCapacity` capacity. */
export function candidates(bits, { minimumCapacity = bits, maximumCapacity = Math.floor(bits * 6 / 5),
  maximumRows = null, maximumColumns = null } = {}) {
  if (!Number.isInteger(bits) || bits < 1) throw new RangeError('Payload must contain at least one bit.');
  const low = Math.max(bits, minimumCapacity);
  const result = [];
  const top = maximumRows ?? maximumCapacity + MAX_CRC_WIDTH + 2;
  for (let h = 1; h <= top; h++) {
    const overhead = crcWidth(h) + 2;
    const from = Math.max(1, Math.ceil((low + overhead) / h));
    let to = Math.floor((maximumCapacity + overhead) / h);
    if (maximumColumns !== null) to = Math.min(to, maximumColumns);
    for (let w = from; w <= to; w++) if (isValidGeometry(h, w)) result.push({ h, w });
  }
  return result;
}

// ---------------------------------------------------------------- payload and CRC, v2.md §5–6

function assertBits(bits, allowEmpty) {
  if (typeof bits !== 'string' || /[^01]/.test(bits) || (!allowEmpty && bits === ''))
    throw new TypeError('Payload must contain only 0 and 1.');
}

/** Unsigned decimal to bits, most significant first; `width` pads with leading zeroes. */
export function bitsFromInteger(decimal, width = 0) {
  const text = String(decimal).trim();
  if (!/^\d+$/.test(text)) throw new TypeError('An unsigned integer contains decimal digits only.');
  const bits = BigInt(text).toString(2);
  if (width > 0 && bits.length > width) throw new RangeError(`${BigInt(text)} needs ${bits.length} bits; the fixed length is ${width}.`);
  return bits.padStart(width, '0');
}

export function crc(dataRegion, h) {
  assertBits(dataRegion, false);
  const width = crcWidth(h);
  const polynomial = FULL_POLYNOMIALS[width];
  let remainder = 0;
  for (const bit of dataRegion + '0'.repeat(width)) {
    remainder = (remainder << 1) | (bit === '1' ? 1 : 0);
    if (remainder & (1 << width)) remainder ^= polynomial;
  }
  return remainder.toString(2).padStart(width, '0');
}

/** Everything before the last `1`; a region without one is a blank matrix, not a code. */
export function payloadFromDataRegion(dataRegion) {
  assertBits(dataRegion, false);
  const at = dataRegion.lastIndexOf('1');
  if (at < 0) throw new RangeError('empty_data_region');
  return dataRegion.slice(0, at);
}

/** Builds a code. `rows` uses O for the orientation feature, as the vectors do. */
export function encode(payload, h, w) {
  assertBits(payload, true);
  if (!isValidGeometry(h, w)) throw new RangeError(`${h} × ${w} is not a valid Open3DPC v2 geometry.`);
  const capacity = payloadCapacity(h, w);
  if (payload.length > capacity) throw new RangeError(`Payload has ${payload.length} bits; ${h} × ${w} holds ${capacity}.`);
  const padding = '0'.repeat(capacity - payload.length);
  const dataRegion = payload + '1' + padding;
  const check = crc(dataRegion, h);
  const cells = [];
  let offset = 0;
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) {
      if (r === 0 && c === 0) row.push({ kind: 'orientation', bit: null });
      else if (c === w - 1 && r < check.length) row.push({ kind: 'crc', bit: check[r] });
      else {
        const kind = offset < payload.length ? 'payload' : offset === payload.length ? 'terminator' : 'padding';
        row.push({ kind, bit: dataRegion[offset++] });
      }
    }
    cells.push(row);
  }
  return { h, w, payload, padding, dataRegion, crc: check, encodedBits: dataRegion + check, cells,
    rows: cells.map((row) => row.map((cell) => cell.bit ?? 'O').join('')) };
}

const rotate = (rows) => Array.from({ length: rows[0].length }, (_, c) => rows.map((row) => row[c]).reverse().join(''));

/** The physical half of a scanner: a sampled matrix in any of four rotations, or a reason. */
export function decode(observed) {
  let rows = observed;
  let sawOrigin = false;
  for (let turn = 0; turn < 4; turn++, rows = rotate(rows)) {
    if (rows.join('').split('O').length !== 2) return { error: 'invalid_orientation' };
    if (rows[0][0] !== 'O') continue;
    sawOrigin = true;
    const h = rows.length;
    const w = rows[0].length;
    if (!isValidGeometry(h, w)) continue;
    const width = crcWidth(h);
    let data = '';
    let check = '';
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (r === 0 && c === 0) continue;
      if (c === w - 1 && r < width) check += rows[r][c]; else data += rows[r][c];
    }
    if (crc(data, h) !== check) return { error: 'crc_mismatch' };
    if (!data.includes('1')) return { error: 'empty_data_region' };
    return { h, w, payload: payloadFromDataRegion(data) };
  }
  return { error: sawOrigin ? 'invalid_geometry' : 'invalid_orientation' };
}

// ---------------------------------------------------------------- drawing, v2.md §3 and §7–8

/** The half-module grid: every normative edge falls on it exactly. 1 is dark. */
export function darkGrid(code) {
  const rows = 2 * code.h + 4;
  const columns = 2 * code.w + 4;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: columns },
    (_, c) => (r === 0 || c === 0 || r === rows - 1 || c === columns - 1 ? 1 : 0)));
  const square = (top, left) => { for (let r = top; r < top + 2; r++) for (let c = left; c < left + 2; c++) grid[r][c] = 1; };
  square(1, 1);
  code.cells.forEach((row, r) => row.forEach((cell, c) => { if (cell.bit === '1') square(2 * (r + 1), 2 * (c + 1)); }));
  return grid;
}

const fixed = (value) => value.toFixed(4);
const svgRect = (x, y, width, height, fill) =>
  `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${fixed(height)}" fill="${fill}"/>`;
export const DEBUG_COLOURS = Object.freeze({
  payload: ['#DBEAFE', '#1D4ED8'], terminator: ['#15803D', '#15803D'], padding: ['#E5E7EB', '#E5E7EB'], crc: ['#D8B4FE', '#7E22CE'],
});

/**
 * Exact SVG in millimetres. `quietZone` adds the M/2 background band of v2.md §3.3 around the code;
 * without it the image is the code alone, as §8 defines it.
 */
export function svg(code, { module = DEFAULT_MODULE_MM, debug = false, quietZone = false } = {}) {
  const { width, height } = physicalSize(code.h, code.w, module);
  const frame = module / 2;
  const shapes = [svgRect(0, 0, width, height, '#111111'), svgRect(frame, frame, width - 2 * frame, height - 2 * frame, '#ffffff')];
  code.cells.forEach((row, r) => row.forEach((cell, c) => {
    if (cell.kind === 'orientation') { shapes.push(svgRect(frame, frame, module, module, '#111111')); return; }
    if (cell.bit !== '1' && !debug) return;
    const x = (c + 1) * module;
    const y = (r + 1) * module;
    shapes.push(svgRect(x, y, module, module, debug ? DEBUG_COLOURS[cell.kind][cell.bit] : '#111111'));
    if (!debug) return;
    const label = cell.kind === 'padding' ? '×' : cell.kind === 'terminator' ? 'T' : cell.bit;
    const dark = cell.kind === 'terminator' || (cell.kind !== 'padding' && cell.bit === '1');
    shapes.push(`<text x="${fixed(x + module / 2)}" y="${fixed(y + module * 0.62)}" text-anchor="middle" font-family="monospace" font-size="${fixed(Math.max(0.35, module * 0.52))}" fill="${dark ? '#ffffff' : '#111111'}">${label}</text>`);
  }));
  const q = quietZone ? frame : 0;
  if (q) shapes.unshift(svgRect(-q, -q, width + 2 * q, height + 2 * q, '#ffffff'));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fixed(width + 2 * q)}mm" height="${fixed(height + 2 * q)}mm" viewBox="${q ? `${fixed(-q)} ${fixed(-q)}` : '0 0'} ${fixed(width + 2 * q)} ${fixed(height + 2 * q)}" role="img" aria-label="Open3DPC code" shape-rendering="crispEdges">${shapes.join('')}</svg>`;
}

/** Grey raster, 0 dark and 255 light. `scale` is pixels per half module. */
export function raster(code, { scale = 40, quietZone = false } = {}) {
  let grid = darkGrid(code);
  if (quietZone) grid = padGrid(grid, 1, 0);
  const width = grid[0].length * scale;
  const height = grid.length * scale;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    pixels[y * width + x] = grid[Math.floor(y / scale)][Math.floor(x / scale)] ? 17 : 255;
  return { width, height, pixels };
}

function padGrid(grid, by, value) {
  const columns = grid[0].length + 2 * by;
  const blank = () => Array.from({ length: by }, () => Array(columns).fill(value));
  const side = Array(by).fill(value);
  return [...blank(), ...grid.map((row) => [...side, ...row, ...side]), ...blank()];
}

// ---------------------------------------------------------------- STL

/** 4-connected dark regions, each printed as its own closed shell. */
export function components(grid) {
  const seen = grid.map((row) => row.map(() => false));
  const found = [];
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[0].length; c++) {
    if (!grid[r][c] || seen[r][c]) continue;
    const component = [];
    const stack = [[r, c]];
    seen[r][c] = true;
    while (stack.length) {
      const [y, x] = stack.pop();
      component.push([y, x]);
      for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ny = y + dy;
        const nx = x + dx;
        if (!grid[ny]?.[nx] || seen[ny][nx]) continue;
        seen[ny][nx] = true;
        stack.push([ny, nx]);
      }
    }
    found.push(component);
  }
  return found;
}

/** Binary STL of the dark material, Z from 0 to `materialHeight`. Row 0 is at the top, seen from +Z. */
export function stl(code, { module = DEFAULT_MODULE_MM, materialHeight = DEFAULT_MATERIAL_HEIGHT_MM } = {}) {
  positive(module, 'Module');
  positive(materialHeight, 'Material height');
  const grid = darkGrid(code);
  const cell = module / 2;
  const total = grid.length * cell;
  const triangles = [];
  for (const component of components(grid)) {
    const own = new Set(component.map(([r, c]) => `${r}:${c}`));
    for (const [r, c] of component) {
      const x0 = c * cell;
      const x1 = (c + 1) * cell;
      const y0 = total - (r + 1) * cell;
      const y1 = total - r * cell;
      box(triangles, x0, y0, x1, y1, 0, materialHeight, {
        top: true, bottom: true,
        north: !own.has(`${r - 1}:${c}`), south: !own.has(`${r + 1}:${c}`),
        west: !own.has(`${r}:${c - 1}`), east: !own.has(`${r}:${c + 1}`),
      });
    }
  }
  return packStl(triangles, 'open3dpc-v2 dark material');
}

/**
 * Binary STL of the light body the dark material sits in: the M/2 quiet zone, the gaps and the zero
 * cells from 0 to `materialHeight`, over a plate `plate` thick below Z = 0. Same origin as `stl`, so
 * the two are loaded as one two-material object. Not part of the specification.
 */
export function backingStl(code, { module = DEFAULT_MODULE_MM, materialHeight = DEFAULT_MATERIAL_HEIGHT_MM, plate = 1 } = {}) {
  positive(module, 'Module');
  positive(materialHeight, 'Material height');
  positive(plate, 'Plate thickness');
  const grid = padGrid(darkGrid(code), 1, 0);
  const cell = module / 2;
  const total = (grid.length - 1) * cell;
  const triangles = [];
  const dark = (r, c) => grid[r]?.[c];
  grid.forEach((row, r) => row.forEach((isDark, c) => {
    const x0 = (c - 1) * cell;
    const y0 = total - (r + 1) * cell;
    const top = isDark ? 0 : materialHeight;
    const outside = (nr, nc) => dark(nr, nc) === undefined;
    box(triangles, x0, y0, x0 + cell, y0 + cell, -plate, 0, {
      top: Boolean(isDark), bottom: true,
      north: outside(r - 1, c), south: outside(r + 1, c), west: outside(r, c - 1), east: outside(r, c + 1),
    });
    if (isDark) return;
    const wall = (nr, nc) => outside(nr, nc) || dark(nr, nc) === 1;
    box(triangles, x0, y0, x0 + cell, y0 + cell, 0, top, {
      top: true, bottom: false,
      north: wall(r - 1, c), south: wall(r + 1, c), west: wall(r, c - 1), east: wall(r, c + 1),
    });
  }));
  return packStl(triangles, 'open3dpc-v2 backing');
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number.`);
}

function box(out, x0, y0, x1, y1, z0, z1, sides) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const face = (a, b, c, d, e, f) => out.push([p[a], p[b], p[c]], [p[d], p[e], p[f]]);
  if (sides.bottom) face(0, 2, 1, 0, 3, 2);
  if (sides.top) face(4, 5, 6, 4, 6, 7);
  if (sides.south) face(0, 1, 5, 0, 5, 4);
  if (sides.north) face(3, 7, 6, 3, 6, 2);
  if (sides.west) face(0, 4, 7, 0, 7, 3);
  if (sides.east) face(1, 2, 6, 1, 6, 5);
}

function packStl(triangles, header) {
  const bytes = new Uint8Array(84 + 50 * triangles.length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header).slice(0, 80));
  view.setUint32(80, triangles.length, true);
  let at = 84;
  for (const [a, b, c] of triangles) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n);
    const normal = length < 1e-12 ? [0, 0, 0] : n.map((value) => value / length);
    for (const value of [...normal, ...a, ...b, ...c]) { view.setFloat32(at, value, true); at += 4; }
    at += 2;
  }
  return bytes;
}
