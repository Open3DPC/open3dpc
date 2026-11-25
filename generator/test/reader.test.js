import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bitsFromInteger, encode, raster } from '../open3dpc.js';
import { Frame, Open3DPCReader, Open3DPCStabilizer, Raster, analyzeRaster, validate } from '../open3dpc-reader.js';
import { directory } from './fixtures.js';

const spec = new URL('../../spec/', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('vectors/v2.json', spec))).vectors;

/** A grey picture: the pixels of a frame, its turns and its poses. */
class Grey {
  constructor(width, height, pixels) { Object.assign(this, { width, height, pixels }); }
  frame() { return new Frame(this.pixels, this.width, this.height); }
  quarter() {
    const out = new Uint8Array(this.pixels.length);
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) out[x * this.height + this.height - 1 - y] = this.pixels[y * this.width + x];
    return new Grey(this.height, this.width, out);
  }
  /** Seen through a pinhole at 3.2 diagonals, on a canvas of `paper`. */
  posed({ yaw = 0, pitch = 0, roll = 0, paper = 255 } = {}) {
    const [a, b, c] = [yaw, pitch, roll].map((d) => (d * Math.PI) / 180);
    const reach = Math.hypot(this.width, this.height);
    const side = Math.ceil(reach + 40);
    const far = reach * 3.2;
    // The plane's axes in camera space, then one ray and one intersection per pixel.
    const turn = (x, y) => {
      const x1 = x * Math.cos(c) - y * Math.sin(c);
      const y1 = x * Math.sin(c) + y * Math.cos(c);
      const z2 = y1 * Math.sin(b);
      return [x1 * Math.cos(a) + z2 * Math.sin(a), y1 * Math.cos(b), z2 * Math.cos(a) - x1 * Math.sin(a)];
    };
    const u = turn(1, 0);
    const v = turn(0, 1);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const out = new Uint8Array(side * side).fill(paper);
    for (let py = 0; py < side; py++) for (let px = 0; px < side; px++) {
      const ray = [px - side / 2, py - side / 2, far];
      const t = (far * n[2]) / dot(ray, n);
      const hit = [ray[0] * t, ray[1] * t, ray[2] * t - far];
      const sx = dot(hit, u) + this.width / 2;
      const sy = dot(hit, v) + this.height / 2;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= this.width || y0 + 1 >= this.height) continue;
      const at = y0 * this.width + x0;
      const top = this.pixels[at] + (this.pixels[at + 1] - this.pixels[at]) * (sx - x0);
      const bottom = this.pixels[at + this.width] + (this.pixels[at + this.width + 1] - this.pixels[at + this.width]) * (sx - x0);
      out[py * side + px] = Math.round(top + (bottom - top) * (sy - y0));
    }
    return new Grey(side, side, out);
  }
}

/** A code on a margin, in module pixels, optionally inverted. */
function drawn(payload, h, w, { scale = 20, margin = 1.2, invert = false } = {}) {
  const code = raster(encode(payload, h, w), { scale });
  const pad = Math.round(margin * scale);
  const width = code.width + 2 * pad;
  const height = code.height + 2 * pad;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < code.height; y++) pixels.set(code.pixels.subarray(y * code.width, (y + 1) * code.width), (y + pad) * width + pad);
  return new Grey(width, height, invert ? pixels.map((p) => 255 - p) : pixels);
}
const upright = ({ width, height, pixels }) => new Raster(Uint8ClampedArray.from({ length: pixels.length * 4 }, (_, i) => (i % 4 === 3 ? 255 : pixels[i >> 2])), width, height);

const fixtures = JSON.parse(readFileSync(`${directory}manifest.json`)).map((f) => {
  const data = readFileSync(directory + f.file);
  const header = /^P5\n(\d+) (\d+)\n255\n/.exec(data.subarray(0, 40).toString('latin1'));
  return { ...f, image: new Grey(Number(header[1]), Number(header[2]), new Uint8Array(data.subarray(header[0].length))) };
});
const fixture = (name) => fixtures.find((f) => f.file === `${name}.pgm`).image;

test('every vector matrix validates in four rotations', () => {
  for (const { id, matrixRows, payload, h, w } of vectors) {
    let rows = matrixRows;
    for (let turn = 0; turn < 4; turn++) {
      assert.deepEqual(validate(rows), { stage: 'validated', bits: payload, rows: h, columns: w }, `${id} turn ${turn}`);
      rows = Array.from(rows[0], (_, c) => rows.map((row) => row[c]).reverse().join(''));
    }
  }
});

test('generated pictures read at seven angles and four turns, never wrongly', () => {
  assert.equal(fixtures.length, 10);
  for (const f of fixtures) {
    let { image } = f;
    for (let turn = 0; turn < 4; turn++, image = image.quarter()) {
      let read = 0;
      for (const roll of [0, 3, 5, 8, 12, 20, 33]) {
        const found = new Open3DPCReader().read(image.posed({ roll }).frame());
        for (const { bits, rows, columns } of found) assert.deepEqual([bits, rows, columns], [f.payload, f.h, f.w], `${f.file} ${roll}`);
        if (found.length === 1) read++;
      }
      if (f.h > 2) assert.ok(read >= 4, `${f.file} turn ${turn * 90}: ${read} of 7`);
    }
  }
});

test('forty codes read in perspective, either way round', () => {
  for (const [pose, invert] of [[{}, false], [{ yaw: 20, roll: 12 }, false], [{ pitch: 30 }, false], [{ yaw: 10 }, true]]) {
    for (let i = 0; i < 40; i++) {
      const payload = bitsFromInteger(128 + Math.floor(i / 5) * 8 + (i % 5), 9);
      const image = drawn(payload, 3, 5, { invert }).posed({ ...pose, paper: invert ? 0 : 255 });
      assert.deepEqual(new Open3DPCReader().read(image.frame()).map((r) => r.bits), [payload], JSON.stringify([pose, invert, i]));
    }
  }
});

test('colour: two materials of one brightness read by hue', () => {
  const grey = drawn(bitsFromInteger(9999, 14), 4, 6);
  const data = new Uint8ClampedArray(grey.pixels.length * 4);
  grey.pixels.forEach((p, i) => data.set(p > 99 ? [233, 167, 203, 255] : [227, 209, 231, 255], i * 4));
  const raster = new Raster(data, grey.width, grey.height);
  const margin = 24;
  assert.equal(analyzeRaster(raster.cropped(margin, margin, grey.width - margin, grey.height - margin)).bits, bitsFromInteger(9999, 14));
  const ink = data.slice();
  grey.pixels.forEach((p, i) => ink.set(p > 99 ? [255, 240, 220, 255] : [150, 20, 30, 255], i * 4));
  assert.deepEqual(new Open3DPCReader().read(Frame.fromImageData({ data: ink, width: grey.width, height: grey.height })).map((r) => r.value), [9999n]);
});

test('a data row is not a side of the frame', () => {
  for (const [h, w] of [[4, 6], [6, 4], [3, 7], [5, 5], [4, 5]]) for (const n of [...Array.from({ length: 54 }, (_, i) => 1 + i * 185), 963]) {
    const payload = bitsFromInteger(n, 14);
    assert.equal(analyzeRaster(upright(drawn(payload, h, w, { scale: 24, margin: 0.5 }))).bits, payload, `${n} on ${h}×${w}`);
  }
});

test('options refuse other lengths and shapes; the region bounds the search', () => {
  const frame = fixture('number-9999-6x4').posed({ roll: 8 }).frame();
  const count = (options, roi) => new Open3DPCReader(options).read(frame, roi).length;
  assert.equal(count(), 1);
  assert.equal(count({ payloadLengths: [14] }), 1);
  assert.equal(count({ payloadLengths: [9, 13] }), 0);
  assert.equal(count({ geometries: [[6, 4]] }), 1);
  assert.equal(count({ geometries: [[4, 6]] }), 0);
  assert.equal(count({}, { left: 0, top: 0, right: 60, bottom: frame.height }), 0);
});

test('the corners are the outside of the frame, also on a plate with its own edge', () => {
  const plate = drawn(bitsFromInteger(4242, 14), 4, 6, { scale: 12, margin: 3 });
  const width = plate.width + 160;
  const pixels = new Uint8Array(width * (plate.height + 160)).fill(150);
  for (let y = 0; y < plate.height; y++) pixels.set(plate.pixels.subarray(y * plate.width, (y + 1) * plate.width), (y + 80) * width + 80);
  const [found] = new Open3DPCReader().read(new Frame(pixels, width, plate.height + 160));
  assert.equal(found.value, 4242n);
  const truth = [[116, 116], [width - 116, 116], [width - 116, plate.height + 44], [116, plate.height + 44]];
  found.corners.forEach(({ x, y }, i) => assert.ok(Math.hypot(x - truth[i][0], y - truth[i][1]) < 14, JSON.stringify([i, x, y, truth[i]])));
});

test('one reader reads frames and regions of changing size', () => {
  const reader = new Open3DPCReader();
  const big = fixture('bits88-10x10');
  const small = fixture('bits9-3x5');
  for (const image of [big, small, big, small]) assert.equal(reader.read(image.frame()).length, 1);
});

test('a track survives frames and confirms on the second', () => {
  const frame = fixture('bits9-3x5').frame();
  const reader = new Open3DPCReader();
  const stabilizer = new Open3DPCStabilizer();
  assert.equal(stabilizer.observe(reader.read(frame), 1000), null);
  assert.equal(stabilizer.observe(reader.read(frame), 1100).bits, '010011011');
  assert.equal(stabilizer.observe([], 1300).bits, '010011011');
  assert.equal(stabilizer.observe([], 1900), null);
});

test('nothing reads from a blank picture, noise or a blank matrix', () => {
  assert.equal(new Open3DPCReader().read(new Frame(new Uint8Array(640 * 360).fill(255), 640, 360)).length, 0);
  assert.equal(new Open3DPCReader().read(new Frame(new Uint8Array(64), 8, 8)).length, 0);
  let seed = 7;
  const noise = Uint8Array.from({ length: 320 * 320 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16);
  assert.equal(new Open3DPCReader().read(new Frame(noise, 320, 320)).length, 0);
  assert.equal(validate(['O00000', '000000', '000000', '000000']).stage, 'emptyDataRegion');
});
