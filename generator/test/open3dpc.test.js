import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as o from '../open3dpc.js';
import { cases, directory, manifest, pgm, picture } from './fixtures.js';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const vectors = json('../../spec/vectors/v2.json');
const golden = json('./reference-golden.json');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const rotate = (rows) => Array.from({ length: rows[0].length }, (_, c) => rows.map((r) => r[c]).reverse().join(''));

test('every vector encodes exactly', () => {
  assert.equal(vectors.vectors.length, 30);
  for (const v of vectors.vectors) {
    const code = o.encode(v.payload, v.h, v.w);
    assert.deepEqual(code.rows, v.matrixRows, v.id);
    assert.equal(code.crc, v.expectedCrc, v.id);
    assert.equal(code.dataRegion, v.dataRegion, v.id);
    assert.equal(code.encodedBits, v.encodedBits, v.id);
    const size = o.physicalSize(v.h, v.w);
    assert.ok(Math.abs(size.width - v.physicalDimensionsMm[0]) < 1e-9 && Math.abs(size.height - v.physicalDimensionsMm[1]) < 1e-9, v.id);
  }
});
test('every vector decodes in all four rotations', () => {
  for (const v of vectors.vectors) {
    let rows = v.matrixRows;
    for (let turn = 0; turn < 4; turn++, rows = rotate(rows)) assert.equal(o.decode(rows).payload, v.payload, `${v.id} turn ${turn}`);
  }
});
test('the polynomial table is the vectors\' table', () => {
  for (const [width, hex] of Object.entries(vectors.fullPolynomials)) assert.equal(o.FULL_POLYNOMIALS[width], Number(hex));
});
test('all-zero regions match their CRC and are still not codes', () => {
  assert.equal(vectors.additionalCrcCases.length, 10);
  for (const v of vectors.additionalCrcCases) {
    assert.equal(o.crc(v.dataRegion, v.h), v.expectedCrc);
    const w = Array.from({ length: 40 }, (_, i) => i + 1).find((n) => o.isValidGeometry(v.h, n));
    const blank = Array.from({ length: v.h }, (_, r) => (r ? '0' : 'O') + '0'.repeat(w - 1));
    assert.equal(o.decode(blank).error, 'empty_data_region');
  }
});
test('any single flipped cell is rejected', () => {
  for (const v of vectors.vectors) for (let r = 0; r < v.h; r++) for (let c = 0; c < v.w; c++) {
    if (!r && !c) continue;
    const rows = v.matrixRows.map((row) => [...row]);
    rows[r][c] = rows[r][c] === '1' ? '0' : '1';
    assert.equal(o.decode(rows.map((row) => row.join(''))).payload, undefined, `${v.id} [${r},${c}]`);
  }
});
test('bad input is refused', () => {
  assert.throws(() => o.encode('1'.repeat(11), 3, 5), RangeError);
  assert.throws(() => o.encode('1', 5, 3), RangeError);
  assert.throws(() => o.encode('12', 3, 5), TypeError);
  assert.throws(() => o.bitsFromInteger('-1'), TypeError);
  assert.throws(() => o.bitsFromInteger('9999', 13), RangeError);
  assert.equal(o.bitsFromInteger('9999', 14), '10011100001111');
  assert.equal(o.bitsFromInteger('1', 14), '00000000000001');
  assert.equal(o.decode(['001', '010']).error, 'invalid_orientation');
});
test('matrix, SVG and STL equal the original PHP generator byte for byte', () => {
  assert.equal(golden.cases.length, 35);
  for (const g of golden.cases) {
    const code = o.encode(g.payload, g.h, g.w);
    assert.deepEqual(code.rows, g.rows, g.id);
    assert.equal(sha(o.svg(code, { module: g.module }).replace(' shape-rendering="crispEdges"', '')), g.svgSha256, `${g.id} svg`);
    const mesh = o.stl(code, { module: g.module, materialHeight: g.materialHeight });
    assert.equal(mesh.length, g.stlBytes, `${g.id} stl size`);
    assert.equal(sha(mesh.subarray(80)), g.stlBodySha256, `${g.id} stl`);
  }
});
test('geometry candidates equal the original PHP generator', () => {
  for (const g of golden.candidates)
    assert.deepEqual(o.candidates(g.bits, { maximumRows: 10, maximumColumns: 10 }).map(({ h, w }) => `${h}x${w}`), g.geometries, `${g.bits} bits`);
});

function triangles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return Array.from({ length: view.getUint32(80, true) }, (_, i) =>
    Array.from({ length: 3 }, (_, p) => Array.from({ length: 3 }, (_, k) => Math.round(view.getFloat32(84 + 50 * i + 12 + 12 * p + 4 * k, true) * 1e4))));
}
function assertClosed(mesh, label) {
  const edges = new Map();
  for (const t of mesh) for (let i = 0; i < 3; i++) {
    const a = t[i].join();
    const b = t[(i + 1) % 3].join();
    edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
  }
  for (const [edge, count] of edges) assert.equal(edges.get(edge.split('|').reverse().join('|')), count, `${label}: open edge ${edge}`);
}
const volume = (mesh) => mesh.reduce((sum, [a, b, c]) => sum +
  (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0) / 1e12;

test('both meshes are closed, outward and fill the plate exactly once', () => {
  for (const { payload, h, w } of cases) {
    const code = o.encode(payload, h, w);
    const dark = triangles(o.stl(code));
    const light = triangles(o.backingStl(code, { plate: 1 }));
    assertClosed(dark, 'dark');
    assertClosed(light, 'backing');
    const { quietWidth, quietHeight } = o.physicalSize(h, w);
    const cells = o.darkGrid(code).flat().filter(Boolean).length;
    assert.ok(Math.abs(volume(dark) - cells * 0.64 * 0.6) < 1e-3);
    assert.ok(Math.abs(volume(dark) + volume(light) - quietWidth * quietHeight * 1.6) < 1e-3);
  }
});
test('the STL seen from above is the code', () => {
  for (const { payload, h, w } of cases) {
    const rows = 2 * h + 4;
    const columns = 2 * w + 4;
    const grid = Array.from({ length: rows }, () => Array(columns).fill(0));
    for (const t of triangles(o.stl(o.encode(payload, h, w)))) {
      if (!t.every((p) => p[2] === 6000)) continue;
      const x = (Math.min(...t.map((p) => p[0])) / 8000);
      const y = (Math.min(...t.map((p) => p[1])) / 8000);
      grid[rows - 1 - Math.round(y)][Math.round(x)] = 1;
    }
    const seen = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) =>
      (!r && !c ? (grid[1][1] && grid[2][2] ? 'O' : '0') : String(grid[2 * r + 2][2 * c + 2]))).join(''));
    assert.equal(o.decode(seen).payload, payload);
  }
});
test('the quiet-zone SVG is one module larger each way', () => {
  const code = o.encode('10011100001111', 4, 6);
  assert.match(o.svg(code, { quietZone: true }), /width="14\.4000mm" height="11\.2000mm" viewBox="-0\.8000 -0\.8000 14\.4000 11\.2000"/);
});
test('the reader fixtures are what the generator draws', () => {
  assert.equal(readFileSync(`${directory}manifest.json`, 'utf8'), manifest());
  for (const item of cases) assert.equal(sha(readFileSync(`${directory}${item.name}.pgm`)), sha(pgm(picture(item))), item.name);
});
