// Open3DPC v2 reader for the browser and Node. No dependencies.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
//
// A port of the Kotlin reader in kotlin/open3dpc, the same stages and constants in the same order.
// docs/reader-pipeline.md explains each stage. One difference: a camera gives the browser RGB, so a
// rectified picture is sampled from RGB directly and not rebuilt from luma and chroma.

import { decode, isValidGeometry } from './open3dpc.js';

// Math.min and Math.max accept lists; the hot paths below use comparisons instead.
const { abs, ceil, floor, hypot, max, min, trunc } = Math;

/** To nearest, away from zero, as the Swift reader rounds. */
const round = (value) => (value >= 0 ? floor(value + 0.5) : ceil(value - 0.5));
const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);
const distance = (a, b) => hypot(a.x - b.x, a.y - b.y);
const sum = (values) => values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------- protocol, v2.md §§5, 6, 9

/**
 * The payload of a sampled matrix, rows of `0`, `1` and one `O`, in any of four rotations.
 * Returns `{ stage: 'validated', bits, rows, columns }`, or the stage it failed at.
 */
export function validate(matrix) {
  const { error, payload, h, w } = decode(matrix);
  if (!error) return { stage: 'validated', bits: payload, rows: h, columns: w };
  return { stage: { invalid_orientation: 'orientation', invalid_geometry: 'geometry', crc_mismatch: 'crc', empty_data_region: 'emptyDataRegion' }[error] };
}

/** How far a candidate got: the index is its priority. */
const STAGES = ['frame', 'sampling', 'geometry', 'ambiguousCell', 'orientation', 'crc', 'emptyDataRegion', 'validated'];

// ---------------------------------------------------------------- frames

/** One image: 8-bit luma, top row first, and RGBA when there is colour. */
export class Frame {
  constructor(luma, width, height, rgba = null) {
    if (!(width > 0 && height > 0) || luma.length < width * height) throw new RangeError('The luma plane is too small.');
    Object.assign(this, { luma, width, height, rgba });
  }
  /** From canvas `ImageData`, or anything with `data` (RGBA), `width` and `height`. */
  static fromImageData({ data, width, height }) {
    const luma = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) luma[i] = (77 * data[j] + 150 * data[j + 1] + 29 * data[j + 2] + 128) >> 8;
    return new Frame(luma, width, height, data);
  }
  get bounds() { return { left: 0, top: 0, right: this.width, bottom: this.height }; }
}

/** RGBA, top-down: the perspective-corrected picture. `chromatic` reads hue instead of brightness. */
export class Raster {
  constructor(bytes, width, height, chromatic = false) { Object.assign(this, { bytes, width, height, chromatic }); }

  brightness(x, y, span, minimumHalf = 1) {
    const { bytes, width, height } = this;
    const half = max(minimumHalf, trunc(span / 2));
    const cx = clamp(round(x), 0, width - 1);
    const cy = clamp(round(y), 0, height - 1);
    const y0 = max(0, cy - half);
    const y1 = min(height - 1, cy + half);
    const x0 = max(0, cx - half);
    const x1 = min(width - 1, cx + half);
    let total = 0;
    for (let row = y0; row <= y1; row++) {
      let i = (row * width + x0) * 4;
      for (let column = x0; column <= x1; column++, i += 4) {
        total += this.chromatic
          ? 128 + 3 * (bytes[i + 1] - (bytes[i] + bytes[i + 2]) / 2)
          : bytes[i] + bytes[i + 1] + bytes[i + 2];
      }
    }
    const samples = (y1 - y0 + 1) * (x1 - x0 + 1);
    return this.chromatic ? total / samples : total / (samples * 3);
  }

  cropped(left, top, right, bottom) {
    const x = max(floor(left), 0);
    const y = max(floor(top), 0);
    const w = min(ceil(right), this.width) - x;
    const h = min(ceil(bottom), this.height) - y;
    if (w < 8 || h < 8) return null;
    const output = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * this.width + x) * 4;
      output.set(this.bytes.subarray(from, from + w * 4), row * w * 4);
    }
    return Object.assign(new Raster(output, w, h, this.chromatic), { x, y });
  }
}

/** The material threshold as a plane: it follows illumination and cannot bend enough to follow the code. */
function thresholdField(image, span) {
  const { width, height } = image;
  const steps = 12;
  const samples = [];
  for (let row = 1; row <= steps; row++) for (let column = 1; column <= steps; column++) {
    const x = column / (steps + 1);
    const y = row / (steps + 1);
    samples.push({ x, y, v: image.brightness(width * x, height * y, span) });
  }
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const { v } of samples) { minimum = min(minimum, v); maximum = max(maximum, v); }
  const contrast = maximum - minimum;
  const flat = { contrast, at: () => (minimum + maximum) / 2 };

  const tiles = 4;
  const points = [];
  for (let tileRow = 0; tileRow < tiles; tileRow++) for (let tileColumn = 0; tileColumn < tiles; tileColumn++) {
    let low = Infinity;
    let high = -Infinity;
    for (const { x, y, v } of samples) if (trunc(x * tiles) === tileColumn && trunc(y * tiles) === tileRow) { low = min(low, v); high = max(high, v); }
    if (!(high - low >= contrast * 0.5)) continue;
    points.push({ x: (tileColumn + 0.5) / tiles, y: (tileRow + 0.5) / tiles, t: (low + high) / 2 });
  }
  if (points.length < 4) return flat;
  const n = points.length;
  const total = (f) => sum(points.map(f));
  const sx = total((p) => p.x);
  const sy = total((p) => p.y);
  const sxx = total((p) => p.x * p.x);
  const syy = total((p) => p.y * p.y);
  const sxy = total((p) => p.x * p.y);
  const right = [total((p) => p.t), total((p) => p.x * p.t), total((p) => p.y * p.t)];
  const determinant = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const matrix = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const whole = determinant(matrix);
  if (abs(whole) <= 1e-9) return flat;
  const [base, perX, perY] = [0, 1, 2].map((column) => determinant(matrix.map((row, r) => row.map((v, c) => (c === column ? right[r] : v)))) / whole);
  if (abs(perX) + abs(perY) < contrast * 0.25) return flat;
  const low = minimum + contrast * 0.2;
  const high = maximum - contrast * 0.2;
  return { contrast, at: (x, y) => clamp(base + perX * (x / width) + perY * (y / height), low, high) };
}

// ---------------------------------------------------------------- perspective

/** The four-point DLT; corners go top-left, top-right, bottom-right, bottom-left in both quadrilaterals. */
function homography(source, destination) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = source[i];
    const { x: u, y: v } = destination[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column; row < 8; row++) if (abs(a[row][column]) > abs(a[pivot][column])) pivot = row;
    if (abs(a[pivot][column]) <= 1e-12) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let i = column; i <= 8; i++) a[column][i] /= divisor;
    for (let row = 0; row < 8; row++) {
      const factor = a[row][column];
      if (row === column || factor === 0) continue;
      for (let i = column; i <= 8; i++) a[row][i] -= factor * a[column][i];
    }
  }
  return a.map((row) => row[8]);
}

/** Every edge offset along its outward normal, the corners re-intersected: aimed just outside the frame. */
function expanded(quad, fraction = 0.08) {
  const sides = quad.map((point, i) => distance(point, quad[(i + 1) % 4]));
  const shortest = min(...sides);
  if (shortest <= 1) return quad;
  const margin = shortest * fraction;
  const centreX = sum(quad.map((p) => p.x)) / 4;
  const centreY = sum(quad.map((p) => p.y)) / 4;
  const lines = quad.map((start, i) => {
    const end = quad[(i + 1) % 4];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const scale = sides[i] > 0 ? sides[i] : 1;
    let nx = -dy / scale;
    let ny = dx / scale;
    if (((start.x + end.x) / 2 - centreX) * nx + ((start.y + end.y) / 2 - centreY) * ny < 0) { nx = -nx; ny = -ny; }
    return { x: start.x + nx * margin, y: start.y + ny * margin, dx, dy };
  });
  return quad.map((point, i) => {
    const a = lines[(i + 3) % 4];
    const b = lines[i];
    const denominator = a.dx * b.dy - a.dy * b.dx;
    if (abs(denominator) <= 1e-6) return point;
    const travel = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / denominator;
    return { x: a.x + a.dx * travel, y: a.y + a.dy * travel };
  });
}

function rectify(frame, quad) {
  const width = round((distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2);
  const height = round((distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2);
  if (!(width >= 8 && height >= 8 && width <= 4096 && height <= 4096)) return null;
  const m = homography([{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }], quad);
  if (!m) return null;
  const output = new Uint8ClampedArray(width * height * 4);
  const source = frame.rgba ?? frame.luma;
  const step = frame.rgba ? 4 : 1;
  const channels = frame.rgba ? 3 : 1;
  const maxX = frame.width - 1;
  const maxY = frame.height - 1;
  let index = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++, index += 4) {
    const w = m[6] * column + m[7] * row + 1;
    const x = clamp((m[0] * column + m[1] * row + m[2]) / w, 0, maxX);
    const y = clamp((m[3] * column + m[4] * row + m[5]) / w, 0, maxY);
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const right = (x0 < maxX ? 1 : 0) * step;
    const down = (y0 < maxY ? frame.width : 0) * step;
    const at = (y0 * frame.width + x0) * step;
    for (let c = 0; c < channels; c++) {
      const p = at + c;
      const top = source[p] + (source[p + right] - source[p]) * fx;
      const bottom = source[p + down] + (source[p + down + right] - source[p + down]) * fx;
      output[index + c] = floor(top + (bottom - top) * fy + 0.5);
    }
    if (channels === 1) output[index + 1] = output[index + 2] = output[index];
    output[index + 3] = 255;
  }
  return new Raster(output, width, height);
}

// ---------------------------------------------------------------- quadrilaterals

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function polygonArea(polygon) {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    total += a.x * b.y - b.x * a.y;
  }
  return abs(total) / 2;
}

/** Andrew's chain. The points arrive sorted by row, then column. */
function convexHull(points) {
  const hull = [];
  const add = (point, lower) => {
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
    hull.push(point);
  };
  for (const point of points) add(point, 2);
  const lower = hull.length + 1;
  for (let i = points.length - 2; i >= 0; i--) add(points[i], lower);
  hull.pop();
  return hull;
}

function intersection(a, b, c, d) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = d.x - c.x;
  const vy = d.y - c.y;
  const denominator = ux * vy - uy * vx;
  if (abs(denominator) < 1e-6) return null;
  const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / denominator;
  return { x: a.x + ux * t, y: a.y + uy * t };
}

/** The vertex that costs the least area goes first, replaced by where its neighbouring edges would meet. */
function fourSides(hull) {
  const polygon = hull.slice();
  while (polygon.length > 4) {
    const size = polygon.length;
    let bestIndex = -1;
    let bestCost = Infinity;
    let bestPoint = null;
    for (let i = 0; i < size; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % size];
      const meet = intersection(polygon[(i + size - 1) % size], a, b, polygon[(i + 2) % size]);
      if (!meet) continue;
      const cost = abs(cross(a, meet, b));
      if (cost < bestCost) { bestCost = cost; bestIndex = i; bestPoint = meet; }
    }
    if (bestIndex < 0) return polygon.slice(0, 4);
    polygon[bestIndex] = bestPoint;
    polygon.splice((bestIndex + 1) % size, 1);
  }
  return polygon;
}

function fitLine(outline, a, b, tolerance) {
  const length = distance(a, b);
  if (length < 3) return null;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  let count = 0;
  let sx = 0;
  let sy = 0;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const { x, y } of outline) {
    const dx = x - a.x;
    const dy = y - a.y;
    const along = dx * ux + dy * uy;
    if (along < 0.12 * length || along > 0.88 * length || abs(dy * ux - dx * uy) > tolerance) continue;
    count++;
    sx += x; sy += y; xx += x * x; xy += x * y; yy += y * y;
  }
  if (count < 4) return null;
  const mx = sx / count;
  const my = sy / count;
  // The principal axis of the scatter: total least squares, so a near-vertical side is not special.
  const theta = 0.5 * Math.atan2(2 * (xy / count - mx * my), xx / count - mx * mx - (yy / count - my * my));
  const dirX = Math.cos(theta);
  const dirY = Math.sin(theta);
  const signed = length * (dirX * ux + dirY * uy >= 0 ? 1 : -1);
  return [{ x: mx, y: my }, { x: mx + dirX * signed, y: my + dirY * signed }];
}

/** Each side refitted through the outline points beside its middle; the corners are where they meet. */
function fittedSides(outline, quad) {
  if (quad.length !== 4) return null;
  const lines = quad.map((start, i) => {
    let line = [start, quad[(i + 1) % 4]];
    for (const tolerance of [3, 1.5]) {
      const fit = fitLine(outline, line[0], line[1], tolerance);
      if (!fit) break;
      line = fit;
    }
    return line;
  });
  const corners = lines.map((line, i) => intersection(...lines[(i + 3) % 4], ...line));
  return corners.includes(null) ? null : corners;
}

function angle(a, b, c) {
  const ux = a.x - b.x;
  const uy = a.y - b.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  return (Math.acos(clamp((ux * vx + uy * vy) / (hypot(ux, uy) * hypot(vx, vy)), -1, 1)) * 180) / Math.PI;
}

/** Clockwise on screen, from the corner nearest the top left. */
function topLeftFirst(corners) {
  const cx = sum(corners.map((p) => p.x)) / 4;
  const cy = sum(corners.map((p) => p.y)) / 4;
  const clockwise = corners.map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) })).sort((a, b) => a.a - b.a).map(({ p }) => p);
  let start = 0;
  for (let i = 1; i < 4; i++) if (clockwise[i].x + clockwise[i].y < clockwise[start].x + clockwise[start].y) start = i;
  return clockwise.map((_, i) => clockwise[(start + i) % 4]);
}

/**
 * Finds the quadrilaterals a code could be. A code's frame is one closed loop, so it is one connected
 * region under a local threshold, whichever way round its colours are. The buffers are kept between frames.
 */
class ContourQuads {
  constructor({ minimumSize, maximumObservations, quadratureTolerance, radiusDivisor, globalPass }) {
    Object.assign(this, { minimumSize, maximumObservations, quadratureTolerance, radiusDivisor, globalPass });
    this.allocate(0);
  }

  allocate(size) {
    this.size = size;
    this.gray = new Uint8Array(size);
    this.labels = new Uint8Array(size);
    this.parents = new Int32Array(size);
    this.boxes = new Int32Array(size * 4);
    this.slots = new Int32Array(size);
    this.integral = new Int32Array(0);
  }

  proposals(frame, roi) {
    const left = max(floor(roi.left), 0);
    const top = max(floor(roi.top), 0);
    const right = min(ceil(roi.right), frame.width);
    const bottom = min(ceil(roi.bottom), frame.height);
    if (right - left < 16 || bottom - top < 16) return [];
    const factor = max(1, trunc(min(right - left, bottom - top) / 480));
    const width = trunc((right - left) / factor);
    const height = trunc((bottom - top) / factor);
    if (this.size < width * height) this.allocate(width * height);
    this.downscale(frame, left, top, factor, width, height);
    const minimumSide = max(floor(min(width, height) * this.minimumSize), 6);
    const found = [];
    const collect = () => {
      for (const region of this.regions(width, height, minimumSide)) {
        const quad = this.quad(region, width, height);
        if (quad) found.push(quad);
      }
    };
    this.threshold(width, height);
    collect();
    if (this.globalPass) { this.globalThreshold(width * height); collect(); }
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const proposal of found) {
      if (kept.length === this.maximumObservations) break;
      const same = kept.some(({ corners: a }) => {
        const tolerance = min(distance(a[0], a[1]), distance(a[1], a[2])) * 0.04;
        return a.every((p, i) => distance(p, proposal.corners[i]) <= tolerance);
      });
      if (!same) kept.push(proposal);
    }
    return kept.map(({ corners }) => corners.map(({ x, y }) => ({ x: (x + 0.5) * factor - 0.5 + left, y: (y + 0.5) * factor - 0.5 + top })));
  }

  downscale(frame, left, top, factor, width, height) {
    const area = factor * factor;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let total = 0;
      for (let row = 0; row < factor; row++) {
        const offset = (top + y * factor + row) * frame.width + left + x * factor;
        for (let column = 0; column < factor; column++) total += frame.luma[offset + column];
      }
      this.gray[y * width + x] = trunc(total / area);
    }
  }

  /** `labels`: 0 background of the mask, 1 darker than its neighbourhood, 2 lighter. */
  threshold(width, height) {
    const stride = width + 1;
    if (this.integral.length < stride * (height + 1)) this.integral = new Int32Array(stride * (height + 1));
    const { integral, gray, labels } = this;
    // The buffer is reused at other widths: its zero row and column have to be zero again.
    for (let x = 0; x <= width; x++) integral[x] = 0;
    for (let y = 0; y < height; y++) {
      let row = 0;
      integral[(y + 1) * stride] = 0;
      for (let x = 0; x < width; x++) {
        row += gray[y * width + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
      }
    }
    const radius = max(7, trunc(min(width, height) / this.radiusDivisor));
    const offset = 4;
    for (let y = 0; y < height; y++) {
      const y0 = max(y - radius, 0) * stride;
      const y1 = min(y + radius + 1, height) * stride;
      for (let x = 0; x < width; x++) {
        const x0 = max(x - radius, 0);
        const x1 = min(x + radius + 1, width);
        const total = integral[y1 + x1] - integral[y0 + x1] - integral[y1 + x0] + integral[y0 + x0];
        const area = (x1 - x0) * ((y1 - y0) / stride);
        const value = gray[y * width + x] * area;
        labels[y * width + x] = value < total - offset * area ? 1 : value > total + offset * area ? 2 : 0;
      }
    }
  }

  /** Otsu over the crop: on a code that fills it, the two materials are the two populations. */
  globalThreshold(count) {
    const histogram = new Int32Array(256);
    for (let i = 0; i < count; i++) histogram[this.gray[i]]++;
    let total = 0;
    for (let level = 0; level < 256; level++) total += level * histogram[level];
    let below = 0;
    let sumBelow = 0;
    let best = 0;
    let split = 128;
    for (let level = 0; level < 256; level++) {
      below += histogram[level];
      if (below === 0 || below === count) continue;
      sumBelow += level * histogram[level];
      const difference = sumBelow / below - (total - sumBelow) / (count - below);
      const between = below * (count - below) * difference * difference;
      if (between > best) { best = between; split = level; }
    }
    for (let i = 0; i < count; i++) this.labels[i] = this.gray[i] <= split ? 1 : 2;
  }

  find(index) {
    const { parents } = this;
    let node = index;
    while (parents[node] !== node) { parents[node] = parents[parents[node]]; node = parents[node]; }
    return node;
  }

  /** Union-find, 8-connected: a thin frame on a slant touches itself only at corners. */
  regions(width, height, minimumSide) {
    const size = width * height;
    const { labels, parents, boxes, slots } = this;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const mask = labels[index];
      parents[index] = index;
      if (mask === 0) continue;
      if (y > 0 && labels[index - width] === mask) { parents[index] = this.find(index - width); continue; }
      const west = x > 0 && labels[index - 1] === mask;
      const northEast = y > 0 && x < width - 1 && labels[index - width + 1] === mask;
      const northWest = !west && y > 0 && x > 0 && labels[index - width - 1] === mask;
      if (west) parents[index] = this.find(index - 1); else if (northWest) parents[index] = this.find(index - width - 1);
      if (northEast) {
        if (west || northWest) {
          const a = this.find(index);
          const b = this.find(index - width + 1);
          if (a !== b) parents[max(a, b)] = min(a, b);
        } else parents[index] = this.find(index - width + 1);
      }
    }
    const roots = [];
    for (let index = 0; index < size; index++) {
      if (labels[index] === 0) continue;
      const root = this.find(index);
      const x = index % width;
      const y = (index - x) / width;
      const at = root * 4;
      if (root === index) { boxes[at] = x; boxes[at + 1] = y; boxes[at + 2] = x; boxes[at + 3] = y; roots.push(root); } else {
        if (x < boxes[at]) boxes[at] = x;
        if (x > boxes[at + 2]) boxes[at + 2] = x;
        boxes[at + 3] = y;
      }
    }
    const kept = roots.map((root) => ({ root, w: boxes[root * 4 + 2] - boxes[root * 4] + 1, h: boxes[root * 4 + 3] - boxes[root * 4 + 1] + 1 }))
      .filter(({ w, h }) => max(w, h) >= minimumSide && min(w, h) >= 3 && !(w >= width - 1 && h >= height - 1))
      .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 96);
    slots.fill(-1, 0, size);
    const regions = kept.map(({ root, w, h }, slot) => {
      slots[root] = slot;
      return {
        minX: boxes[root * 4], minY: boxes[root * 4 + 1],
        rowFirst: new Int32Array(h).fill(-1), rowLast: new Int32Array(h),
        columnFirst: new Int32Array(w).fill(-1), columnLast: new Int32Array(w),
      };
    });
    for (let y = 0, index = 0; y < height; y++) for (let x = 0; x < width; x++, index++) {
      if (labels[index] === 0) continue;
      const slot = slots[this.find(index)];
      if (slot < 0) continue;
      const region = regions[slot];
      const row = y - region.minY;
      const column = x - region.minX;
      if (region.rowFirst[row] < 0) region.rowFirst[row] = x;
      region.rowLast[row] = x;
      if (region.columnFirst[column] < 0) region.columnFirst[column] = y;
      region.columnLast[column] = y;
    }
    return regions;
  }

  quad(region, width, height) {
    const outline = [];
    region.rowFirst.forEach((first, row) => {
      if (first >= 0) outline.push({ x: first, y: row + region.minY }, { x: region.rowLast[row], y: row + region.minY });
    });
    const hull = convexHull(outline);
    region.columnFirst.forEach((first, column) => {
      if (first >= 0) outline.push({ x: column + region.minX, y: first }, { x: column + region.minX, y: region.columnLast[column] });
    });
    if (hull.length < 4) return null;
    const hullArea = polygonArea(hull);
    const corners = fittedSides(outline, fourSides(hull));
    if (!corners) return null;
    const area = polygonArea(corners);
    if (!(area > 0)) return null;
    const fill = min(area, hullArea) / max(area, hullArea);
    if (fill < 0.82) return null;
    const sides = corners.map((p, i) => distance(p, corners[(i + 1) % 4]));
    const minimumAspect = 0.08;
    if (min(...sides) < min(width, height) * this.minimumSize || min(...sides) / max(...sides) < minimumAspect) return null;
    const horizontal = (sides[0] + sides[2]) / 2;
    const vertical = (sides[1] + sides[3]) / 2;
    if (min(horizontal, vertical) / max(horizontal, vertical) < minimumAspect) return null;
    let worst = 0;
    for (let i = 0; i < 4; i++) worst = max(worst, abs(angle(corners[(i + 3) % 4], corners[i], corners[(i + 1) % 4]) - 90));
    if (worst > this.quadratureTolerance) return null;
    if (corners.some(({ x, y }) => x < -2 || y < -2 || x > width + 1 || y > height + 1)) return null;
    return { corners: topLeftFirst(corners), score: fill * (1 - worst / 180) * area };
  }
}

// ---------------------------------------------------------------- lattice sampling

const CORNERS = [{ id: 0, x: 1, y: 1 }, { id: 1, x: -1, y: 1 }, { id: 2, x: -1, y: -1 }, { id: 3, x: 1, y: -1 }];
const CORNER_ORIGINS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const OFFSETS = [-0.55, -0.28, 0, 0.28, 0.55];
/** How far the leader must beat the runner-up on its least confident cell to settle a tie. */
const CELL_CONFIDENCE_TIE_BREAK = 0.10;
/** When the cells cannot settle a tie, the module measured on the orientation corner (1.5M) may. */
const SCALE_AGREEMENT = 0.08;
const SCALE_SEPARATION = 0.04;

const median = (values) => (values.length ? values.slice().sort((a, b) => a - b)[trunc(values.length / 2)] : null);
/** The thinner of two medians: the thicker one may have data against it. */
const thinner = (near, far) => (near !== null && far !== null ? min(near, far) : near ?? far);

/** Whether exactly one corner has material running inwards: the orientation square. */
function singleCornerStep(width, height, steps, isMaterial) {
  const shortest = min(width, height);
  if (!(shortest > 0)) return false;
  const uScale = shortest / width;
  const vScale = shortest / height;
  const runs = CORNER_ORIGINS.map(([ou, ov]) => {
    let last = 0;
    let background = 0;
    for (let i = 1; i <= steps; i++) {
      const d = (0.45 * i) / steps;
      if (isMaterial(ou === 0 ? d * uScale : 1 - d * uScale, ov === 0 ? d * vScale : 1 - d * vScale)) { last = d; background = 0; } else if (++background >= 2) break;
    }
    return last;
  }).sort((a, b) => a - b);
  return runs[3] >= 0.03 && runs[3] >= runs[2] * 1.6;
}

/** Accepted shapes as `[rows, columns]`, each also turned a quarter: the picture may hold the code on its side. */
function shapeSet(geometries) {
  const shapes = new Map();
  for (const [h, w] of geometries) for (const [rows, columns] of [[h, w], [w, h]]) shapes.set(`${rows}x${columns}`, [rows, columns]);
  return [...shapes.values()];
}

/** How far the module a shape's frame gives across may differ from the one it gives down: perspective. */
const HINTED_ASPECT_LIMIT = 0.35;
/** How far it may differ from a module measured between two edges of one kind, which glare does not move. */
const HINTED_EDGE_LIMIT = 0.12;
/** Glare only thins material, so a module measured from a run of it is short, never long: the range allowed. */
const HINTED_RUN_RANGE = [0.9, 1.6];

/**
 * The accepted shapes this frame can be, each at the module its own frame gives. Glare that thins the
 * frame shrinks the outside and widens the opening by the same amount, so their mean, (W + 1.5) modules,
 * holds still: the module does not depend on a measurement glare can move. A shape is kept while the
 * module it gives across and down agree and stay near what was measured, so the hint never forces a
 * picture into a shape it does not have: a shape one row too many gives a module shorter than any glare
 * explains. The checksum still decides.
 */
function hintedGeometries(shapes, width, height, openWidth, openHeight, mx, my, edgeMeasured) {
  const geometries = [];
  for (const [rows, columns] of shapes) {
    const across = (width + openWidth) / (2 * columns + 3);
    const down = (height + openHeight) / (2 * rows + 3);
    const aspect = abs(across / down - 1);
    const ratios = [across / mx, down / my];
    const agrees = edgeMeasured
      ? ratios.every((ratio) => abs(ratio - 1) <= HINTED_EDGE_LIMIT)
      : ratios.every((ratio) => ratio >= HINTED_RUN_RANGE[0] && ratio <= HINTED_RUN_RANGE[1]);
    const hm = width / (columns + 2);
    const vm = height / (rows + 2);
    if (min(hm, vm) < 2.5 || aspect > HINTED_ASPECT_LIMIT || !agrees) continue;
    const scaleError = edgeMeasured ? max(...ratios.map((ratio) => abs(ratio - 1))) : aspect;
    geometries.push([rows, columns, hm, vm, scaleError]);
  }
  return geometries.sort((a, b) => a[4] - b[4]);
}

/** The material ring inside the proposal's neighbourhood, innermost sound ring first. */
function refinedOuterFrame(image) {
  const { width, height } = image;
  const shortestSide = min(width, height);
  if (shortestSide < 24) return null;
  const probe = max(1, shortestSide / 220);
  const field = thresholdField(image, probe);
  if (field.contrast < 28) return null;

  const material = (x, y, span, light, minimumHalf = 1) => {
    const brightness = image.brightness(x, y, span, minimumHalf);
    return light ? brightness > field.at(x, y) : brightness < field.at(x, y);
  };
  const lineScore = (position, vertical, light, from = 0, to = 1) => {
    const span = max(0.05, to - from);
    let hits = 0;
    for (let i = 1; i <= 15; i++) {
      const fraction = from + (span * i) / 16;
      if (material(vertical ? position : width * fraction, vertical ? height * fraction : position, probe, light)) hits++;
    }
    return hits / 15;
  };
  const candidateLines = (lower, upper, vertical, light, outermostFirst) => {
    const limit = vertical ? width : height;
    const end = min(limit - 1, floor(limit * upper));
    const bands = [];
    let first = -1;
    let last = -1;
    const close = () => { if (first >= 0) bands.push((first + last) / 2); first = -1; };
    for (let position = max(0, ceil(limit * lower)); position <= end; position++) {
      if (lineScore(position, vertical, light) >= 0.60) { if (first < 0) first = position; last = position; } else close();
    }
    close();
    return (outermostFirst ? bands : bands.reverse()).slice(0, 3);
  };
  const materialRun = (position, vertical, light, from, to) => {
    const limit = vertical ? width : height;
    const crossLimit = vertical ? height : width;
    const span = max(0.05, to - from);
    const runs = (fractions) => {
      const output = [];
      for (const fraction of fractions) {
        const across = crossLimit * (from + span * fraction);
        const isMaterial = (p) => material(vertical ? p : across, vertical ? across : p, 0, light, 0);
        if (!isMaterial(position)) continue;
        let low = position;
        while (low > 0 && isMaterial(low - 1)) low--;
        let high = position;
        while (high < limit - 1 && isMaterial(high + 1)) high++;
        output.push(high - low + 1);
      }
      return output;
    };
    return thinner(median(runs([0.20, 0.28, 0.36, 0.44])), median(runs([0.56, 0.64, 0.72, 0.80])));
  };

  const refined = ({ l, r, t, b, light }) => {
    const left = materialRun(l, true, light, t / height, b / height);
    const right = materialRun(r, true, light, t / height, b / height);
    const top = materialRun(t, false, light, l / width, r / width);
    const bottom = materialRun(b, false, light, l / width, r / width);
    if (left === null || right === null || top === null || bottom === null) return null;
    const outerWidth = r - l + (left + right) / 2;
    const outerHeight = b - t + (top + bottom) / 2;
    if (max(left, right, top, bottom) > min(outerWidth, outerHeight) * 0.18 ||
      abs(left - right) / max(left, right) > 0.55 || abs(top - bottom) / max(top, bottom) > 0.55) return null;
    const hits = (points) => points.filter(([x, y]) => material(x, y, probe, light)).length;
    // A row of data cells can score as a side of the ring. Only a frame side reaches its neighbours:
    // between a data row and the frame the format keeps an M/2 gap, so look there.
    if (hits([[l + left, t], [r - right, t], [l + left, b], [r - right, b], [l, t + top], [l, b - bottom], [r, t + top], [r, b - bottom]]) < 7) return null;
    const inside = [0.22, 0.36, 0.50, 0.64, 0.78].flatMap((f) => {
      const x = l + (r - l) * f;
      const y = t + (b - t) * f;
      return [[l + left * 0.9, y], [r - right * 0.9, y], [x, t + top * 0.9], [x, b - bottom * 0.9]];
    });
    if (1 - hits(inside) / inside.length < 0.65) return null;
    const minX = max(l - left / 2, 0);
    const minY = max(t - top / 2, 0);
    const maxX = min(l - left / 2 + outerWidth, width);
    const maxY = min(t - top / 2 + outerHeight, height);
    if (minX >= maxX || minY >= maxY) return null;
    const x = floor(minX);
    const y = floor(minY);
    const w = ceil(maxX) - x;
    const h = ceil(maxY) - y;
    if (w < 16 || h < 16 || !(w < width * 0.98 || h < height * 0.98)) return null;
    return image.cropped(x, y, x + w, y + h);
  };

  const rings = [];
  for (const light of [false, true]) {
    const lefts = candidateLines(0, 0.35, true, light, true);
    const rights = candidateLines(0.65, 1, true, light, false);
    const tops = candidateLines(0, 0.35, false, light, true);
    const bottoms = candidateLines(0.65, 1, false, light, false);
    for (const l of lefts) for (const r of rights) {
      if (r - l < 16) continue;
      for (const t of tops) for (const b of bottoms) {
        if (b - t < 16) continue;
        const scores = [
          lineScore(l, true, light, t / height, b / height), lineScore(r, true, light, t / height, b / height),
          lineScore(t, false, light, l / width, r / width), lineScore(b, false, light, l / width, r / width),
        ];
        if (min(...scores) < 0.67) continue;
        let opposite = 0;
        for (let row = 2; row <= 8; row++) for (let column = 2; column <= 8; column++) {
          const x = l + ((r - l) * column) / 10;
          const y = t + ((b - t) * row) / 10;
          const brightness = image.brightness(x, y, probe);
          if (light ? brightness < field.at(x, y) : brightness > field.at(x, y)) opposite++;
        }
        const interior = opposite / 49;
        if (sum(scores) / 4 + interior * 0.30 < 0.80 || interior < 0.12) continue;
        if (!singleCornerStep(r - l, b - t, 24, (u, v) => material(l + (r - l) * u, t + (b - t) * v, probe, light))) continue;
        rings.push({ l, r, t, b, light, area: (r - l) * (b - t) });
      }
    }
  }
  rings.sort((a, b) => a.area - b.area);
  for (const ring of rings) {
    const result = refined(ring);
    if (result) return result;
  }
  return null;
}

function samplingPriority(result) {
  return (result.physical ? 10000 : 0) + (result.sampled ? 1000 : 0) + (result.measured ? 100 : 0) + (result.markerScore ?? 0);
}

function sampleCore(image, shapes = null) {
  const { width, height } = image;
  const shortestSide = min(width, height);
  const failure = { sampled: null, rejection: 'rectified frame too small', rank: 0, measured: false, markerScore: null, physical: false };
  if (shortestSide < 16) return failure;
  const field = thresholdField(image, max(1, shortestSide / 120));
  failure.rejection = 'frame contrast below threshold';
  if (field.contrast < 28) return failure;
  failure.rejection = 'candidate interior lacks opposite material';
  const reject = (rejection, rank) => { if (rank >= failure.rank) { failure.rejection = rejection; failure.rank = rank; } };
  const diagnose = (measured, markerScore) => { failure.measured = measured; failure.markerScore = markerScore; };
  const candidates = [];

  for (const light of [false, true]) {
    const isMaterial = (brightness, x, y) => (light ? brightness > field.at(x, y) : brightness < field.at(x, y));
    const materialAt = (x, y, span, minimumHalf) => isMaterial(image.brightness(x, y, span, minimumHalf), x, y);
    const materialFraction = (cx, cy, rx, ry, span) => {
      let hits = 0;
      for (const ox of OFFSETS) for (const oy of OFFSETS) if (materialAt(cx + ox * rx, cy + oy * ry, span)) hits++;
      return hits / 25;
    };

    const ringProbe = max(1, shortestSide / 150);
    const interior = materialFraction(width * 0.5, height * 0.5, width * 0.38, height * 0.38, ringProbe);
    let ring = 0;
    for (const depth of [0.02, 0.05, 0.08]) {
      const inset = max(1, shortestSide * depth);
      let hits = 0;
      for (let i = 1; i <= 9; i++) {
        const f = i / 10;
        if (materialAt(width * f, inset, ringProbe)) hits++;
        if (materialAt(width * f, height - inset, ringProbe)) hits++;
        if (materialAt(inset, height * f, ringProbe)) hits++;
        if (materialAt(width - inset, height * f, ringProbe)) hits++;
      }
      ring = max(ring, hits / 36);
    }
    if (ring < 0.70) { diagnose(false, null); reject('outer frame ring is not this polarity’s material', 1); continue; }
    if (interior < 0.025) { diagnose(false, null); reject('candidate interior lacks opposite material', 1); continue; }

    const transition = (sx, sy, dx, dy, limit) => {
      const sample = (d) => image.brightness(sx + dx * d, sy + dy * d, 0, 0);
      const inMaterial = (d) => isMaterial(sample(d), sx + dx * d, sy + dy * d);
      const coarse = max(0.5, shortestSide / 240);
      let entry = coarse * 0.5;
      while (entry <= limit && !inMaterial(entry)) entry += coarse;
      if (entry > limit) return null;
      const skipped = entry - coarse * 0.5;
      let last = entry;
      let end = null;
      for (let d = entry + coarse; d <= limit; d += coarse) {
        if (!inMaterial(d)) { end = d; break; }
        last = d;
      }
      if (end === null) return null;
      let previous = sample(last);
      const crossing = (d) => {
        const span = sample(d) - previous;
        return clamp(abs(span) > 0.0001 ? (field.at(sx + dx * d, sy + dy * d) - previous) / span : 0.5, 0, 1) * 0.5;
      };
      let fine = last + 0.5;
      while (fine < end) {
        if (!inMaterial(fine)) return fine - 0.5 + crossing(fine) - skipped;
        previous = sample(fine);
        fine += 0.5;
      }
      return max(fine - 0.5, last) + crossing(end) - skipped;
    };
    const edgeThickness = (sx, sy, dx, dy) => {
      const across = dx !== 0;
      const limit = (across ? width : height) * 0.22;
      const transitions = (fractions) => fractions
        .map((f) => transition(across ? sx : width * f, across ? height * f : sy, dx, dy, limit)).filter((v) => v !== null);
      const near = transitions([0.25, 0.35, 0.45]);
      const far = transitions([0.55, 0.65, 0.75]);
      return near.length + far.length < 3 ? null : thinner(median(near), median(far));
    };
    const left = edgeThickness(0, 0, 1, 0);
    const right = edgeThickness(width - 1, 0, -1, 0);
    const top = edgeThickness(0, 0, 0, 1);
    const bottom = edgeThickness(0, height - 1, 0, -1);
    const horizontal = (left + right) / 2;
    const vertical = (top + bottom) / 2;
    if ([left, right, top, bottom].includes(null) || horizontal <= 0.5 || vertical <= 0.5 || horizontal > width * 0.2 || vertical > height * 0.2 ||
      abs(left - right) / horizontal > 0.25 || abs(top - bottom) / vertical > 0.25) {
      diagnose(false, null);
      reject('outer frame thickness is inconsistent', 2);
      continue;
    }

    let mx = horizontal * 2;
    let my = vertical * 2;
    // Whether the module was measured between two edges of one kind, so that glare cannot have moved it.
    let edgeMeasured = false;
    const cornerRun = (corner, alongX, across) => {
      const step = max(0.5, shortestSide / 240);
      const side = alongX ? width : height;
      let last = 0;
      let background = 0;
      for (let d = 0; d <= side * 0.6; d += step) {
        const along = (alongX ? corner.x : corner.y) > 0 ? d : side - d;
        if (materialAt(alongX ? along : across, alongX ? across : along, 0, 0)) { last = d; background = 0; } else if (++background >= 2) break;
      }
      return last;
    };
    const blocks = CORNERS.map((corner) => {
      const x = cornerRun(corner, true, corner.y > 0 ? my : height - my);
      const y = cornerRun(corner, false, corner.x > 0 ? mx : width - mx);
      return { x, y, least: min(x, y) };
    });
    let best = 0;
    for (let i = 1; i < 4; i++) if (blocks[best].least < blocks[i].least) best = i;
    const medianOther = blocks.filter((_, i) => i !== best).map((block) => block.least).sort((a, b) => a - b)[1];
    const blockMx = blocks[best].x / 1.5;
    const blockMy = blocks[best].y / 1.5;
    const plausible = (ratio) => ratio > 0.55 && ratio < 1.9;
    if (blocks[best].least >= medianOther * 1.8 && plausible(blockMx / mx) && plausible(blockMy / my)) {
      mx = 0.9 * blockMx + 0.1 * mx;
      my = 0.9 * blockMy + 0.1 * my;
      // The frame's inner edge and the feature's far edge both turn material into background, so blur or
      // glare that moves one moves the other the same way: their distance is M itself. Thickness and the
      // corner block are runs of material, and glare shrinks both.
      const corner = CORNERS[best];
      const featureEdge = (alongX) => {
        const runs = [];
        for (const f of [0.3, 0.5, 0.7]) {
          const run = alongX
            ? transition(corner.x > 0 ? 0 : width - 1, corner.y > 0 ? vertical + f * my : height - vertical - f * my, corner.x > 0 ? 1 : -1, 0, width * 0.6)
            : transition(corner.x > 0 ? horizontal + f * mx : width - horizontal - f * mx, corner.y > 0 ? 0 : height - 1, 0, corner.y > 0 ? 1 : -1, height * 0.6);
          if (run !== null) runs.push(run);
        }
        return runs.length >= 2 ? median(runs) : null;
      };
      const featureX = featureEdge(true);
      const featureY = featureEdge(false);
      const edgeMx = featureX === null ? null : featureX - (corner.x > 0 ? left : right);
      const edgeMy = featureY === null ? null : featureY - (corner.y > 0 ? top : bottom);
      if (edgeMx !== null && edgeMy !== null && abs(edgeMx / mx - 1) < 0.3 && abs(edgeMy / my - 1) < 0.3) {
        mx = edgeMx;
        my = edgeMy;
        edgeMeasured = true;
      }
    }
    // The opening inside the frame is (W + 1) × (H + 1) modules whatever the blur: both of its edges move
    // with the material. The whole frame, (W + 2) × (H + 2), grows and shrinks with it.
    const openWidth = width - left - right;
    const openHeight = height - top - bottom;
    const span = min(mx, my) * 0.12;

    const blockScore = (corner, hm, vm) => {
      const x = corner.x > 0 ? horizontal : width - horizontal - hm;
      const y = corner.y > 0 ? vertical : height - vertical - vm;
      return materialFraction(x + hm / 2, y + vm / 2, hm * 0.34, vm * 0.34, span);
    };
    const markers = (hm, vm) => CORNERS.filter((corner) => blockScore(corner, hm, vm) >= 0.88);
    const measuredMarkers = markers(mx, my);
    // With the shapes known, each one is tried at the module its own frame gives, so a module measured
    // wrong under glare cannot reject the code here.
    if (measuredMarkers.length !== 1 && !shapes) {
      diagnose(true, null);
      reject(measuredMarkers.length ? 'ambiguous frame-attached corner markers' : 'no unique frame-attached marker', 3);
      continue;
    }
    diagnose(true, measuredMarkers.length === 1 ? blockScore(measuredMarkers[0], mx, my) : null);

    const geometries = shapes ? hintedGeometries(shapes, width, height, openWidth, openHeight, mx, my, edgeMeasured) : [];
    if (!shapes) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rows = round(openHeight / my) - 1 + dr;
      const columns = round(openWidth / mx) - 1 + dc;
      if (!isValidGeometry(rows, columns) && !isValidGeometry(columns, rows)) continue;
      const hm = width / (columns + 2);
      const vm = height / (rows + 2);
      const scaleError = max(abs(openWidth / (columns + 1) / mx - 1), abs(openHeight / (rows + 1) / my - 1));
      if (min(hm, vm) < 2.5 || scaleError > 0.20) continue;
      geometries.push([rows, columns, hm, vm, scaleError]);
    }
    if (!geometries.length) { reject(shapes ? 'frame fits none of the accepted shapes' : 'frame scale does not fit a protocol-valid grid', 5); continue; }

    for (const [rows, columns, hm, vm, scaleError] of geometries) {
      const found = markers(hm, vm);
      if (found.length !== 1 || (!shapes && found[0].id !== measuredMarkers[0].id)) { reject('corner marker does not agree with measured frame scale', 5); continue; }
      const marker = found[0];
      const markerScore = blockScore(marker, hm, vm);
      const markerRow = marker.y > 0 ? 0 : rows - 1;
      const markerColumn = marker.x > 0 ? 0 : columns - 1;

      let frameHits = 0;
      for (let i = 1; i <= 18; i++) {
        const x = (width * i) / 19;
        const y = (height * i) / 19;
        if (materialAt(x, vm * 0.25, span)) frameHits++;
        if (materialAt(x, height - vm * 0.25, span)) frameHits++;
        if (materialAt(hm * 0.25, y, span)) frameHits++;
        if (materialAt(width - hm * 0.25, y, span)) frameHits++;
      }
      const frameScore = frameHits / 72;
      if (frameScore < 0.76) { reject('outer frame is not continuous', 2); continue; }
      failure.physical = true;

      const px = (inset) => (marker.x > 0 ? inset : width - inset);
      const py = (inset) => (marker.y > 0 ? inset : height - inset);
      const quiet = [[px(1.75 * hm), py(vm)], [px(hm), py(1.75 * vm)], [px(1.75 * hm), py(1.75 * vm)]];
      const clear = ([x, y]) => !materialAt(x, y, span);
      if (!quiet.every(clear)) { reject('marker-to-module background band missing', 3); continue; }
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        if (row === markerRow && column === markerColumn) continue;
        const cx = (column + 1.5) * hm;
        const cy = (row + 1.5) * vm;
        if (column === 0) quiet.push([0.75 * hm, cy]);
        if (column === columns - 1) quiet.push([width - 0.75 * hm, cy]);
        if (row === 0) quiet.push([cx, 0.75 * vm]);
        if (row === rows - 1) quiet.push([cx, height - 0.75 * vm]);
      }
      const quietScore = quiet.filter(clear).length / quiet.length;
      if (quietScore < 0.84) { reject('background band between frame and modules missing', 3); continue; }

      let confidence = 1;
      const matrix = [];
      for (let row = 0; row < rows; row++) {
        let line = '';
        for (let column = 0; column < columns; column++) {
          if (row === markerRow && column === markerColumn) { line += 'O'; continue; }
          const fraction = materialFraction((column + 1.5) * hm, (row + 1.5) * vm, hm * 0.30, vm * 0.30, span);
          confidence = min(confidence, abs(fraction - 0.5) * 2);
          line += fraction >= 0.5 ? '1' : '0';
        }
        matrix.push(line);
      }
      if (confidence < 0.30) { reject('ambiguous cell', 4); continue; }
      candidates.push({
        matrix, rows, columns, frameScore, markerScore, confidence,
        score: 0.45 * frameScore + 0.25 * markerScore + 0.20 * quietScore + 0.10 * confidence,
        scaleError,
        edgeMeasured: edgeMeasured || shapes !== null,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = candidates;
  if (!best) return failure;
  const accepted = (sampled) => ({ sampled, rejection: '', rank: 0, measured: true, markerScore: sampled.markerScore, physical: true });
  if (runnerUp && (runnerUp.rows !== best.rows || runnerUp.columns !== best.columns) && best.score - runnerUp.score < 0.06 &&
    best.confidence - runnerUp.confidence < CELL_CONFIDENCE_TIE_BREAK) {
    const tied = candidates.filter((c) => best.score - c.score < 0.06).sort((a, b) => a.scaleError - b.scaleError);
    if (tied[0].edgeMeasured && tied[0].scaleError <= SCALE_AGREEMENT && tied[1].scaleError - tied[0].scaleError >= SCALE_SEPARATION) return accepted(tied[0]);
    return { ...accepted(best), sampled: null, rejection: `ambiguous geometry ${best.rows}×${best.columns} / ${runnerUp.rows}×${runnerUp.columns}` };
  }
  return accepted(best);
}

function sample(image, shapes) {
  const raw = sampleCore(image, shapes);
  const refined = refinedOuterFrame(image);
  if (!refined) return raw;
  const registered = sampleCore(refined, shapes);
  return (registered.physical || !raw.physical) && registered.measured ? { ...registered, crop: refined } : raw;
}

/** Brightness first; hue is a second attempt, selected by outcome and never by a statistic. */
function sampleOnEitherAxis(image, shapes = null) {
  const first = sample(image, shapes);
  if (first.sampled) return first;
  const chromatic = sample(new Raster(image.bytes, image.width, image.height, true), shapes);
  return samplingPriority(chromatic) > samplingPriority(first) ? chromatic : first;
}

function judged({ sampled, rejection }) {
  if (!sampled) return { stage: rejection === 'ambiguous cell' ? 'ambiguousCell' : 'sampling', detail: rejection };
  return { ...validate(sampled.matrix), frameScore: sampled.frameScore, detail: '' };
}

/** The verdict on one picture that is already the code and nothing else, upright or turned. */
export const analyzeRaster = (raster, shapes = null) => judged(sampleOnEitherAxis(raster, shapes && shapeSet(shapes)));

// ---------------------------------------------------------------- one frame

function boundsOf(corners) {
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return [min(...xs), min(...ys), max(...xs), max(...ys)];
}

function overlap(a, b) {
  const width = min(a[2], b[2]) - max(a[0], b[0]);
  const height = min(a[3], b[3]) - max(a[1], b[1]);
  if (width < 0 || height < 0) return 0;
  const shared = width * height;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared;
  return union > 0 ? shared / union : 0;
}

function inside(corners, u, v) {
  const [a, b, c, d] = corners;
  const topX = a.x + (b.x - a.x) * u;
  const topY = a.y + (b.y - a.y) * u;
  const bottomX = d.x + (c.x - d.x) * u;
  const bottomY = d.y + (c.y - d.y) * u;
  return { x: topX + (bottomX - topX) * v, y: topY + (bottomY - topY) * v };
}

function brightnessIn(frame, corners) {
  return (u, v) => {
    const { x, y } = inside(corners, u, v);
    return frame.luma[clamp(round(y), 0, frame.height - 1) * frame.width + clamp(round(x), 0, frame.width - 1)];
  };
}

/** The frame of the code itself: a reading may come from a wider quadrilateral, refined inside. */
function outlineOf({ corners, image, sampling: { crop } }) {
  const { x = 0, y = 0, width, height } = crop ?? image;
  const square = (left, top, right, bottom) => [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  const m = homography(square(0, 0, image.width - 1, image.height - 1), corners);
  return m ? square(x, y, x + width - 1, y + height - 1).map((p) => {
    const w = m[6] * p.x + m[7] * p.y + 1;
    return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
  }) : corners;
}

/** Null when the inside of the quadrilateral is one colour. */
function preflight(frame, corners) {
  const brightness = brightnessIn(frame, corners);
  const edge = [];
  for (let step = 1; step <= 8; step++) {
    const t = step / 9;
    edge.push(brightness(t, 0.025), brightness(t, 0.975), brightness(0.025, t), brightness(0.975, t));
  }
  const interior = [];
  for (let row = 0; row < 9; row++) for (let column = 0; column < 9; column++) interior.push(brightness(0.1 + column * 0.1, 0.1 + row * 0.1));
  const minimum = min(...edge, ...interior);
  const maximum = max(...edge, ...interior);
  if (maximum - minimum < 28) return null;
  const threshold = (minimum + maximum) / 2;
  const light = sum(edge) / edge.length > threshold;
  const opposite = interior.filter((v) => (light ? v < threshold : v > threshold)).length;
  return opposite / interior.length >= 0.01 ? { threshold, light } : null;
}

function hasCornerStep(frame, corners, { threshold, light }) {
  const brightness = brightnessIn(frame, corners);
  const width = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2;
  const height = (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2;
  return singleCornerStep(width, height, 36, (u, v) => (light ? brightness(u, v) > threshold : brightness(u, v) < threshold));
}

/**
 * Finds Open3DPC codes in camera frames and images. Use one reader per camera: it follows codes
 * between frames and keeps its buffers.
 *
 * `payloadLengths`: payload lengths your application understands. Set it: fewer accepted lengths means
 * fewer false reads. `geometries`: shapes it prints, as `[rows, columns]`. Both default to any.
 */
export class Open3DPCReader {
  constructor({ payloadLengths = null, geometries = null } = {}) {
    this.payloadLengths = payloadLengths && new Set(payloadLengths);
    this.geometries = geometries && new Set(geometries.map(([rows, columns]) => `${rows}x${columns}`));
    this.shapes = geometries && shapeSet(geometries);
    this.coarse = new ContourQuads({ minimumSize: 0.045, maximumObservations: 48, quadratureTolerance: 35, radiusDivisor: 20, globalPass: false });
    this.second = new ContourQuads({ minimumSize: 0.06, maximumObservations: 5, quadratureTolerance: 18, radiusDivisor: 9, globalPass: true });
    this.frameNumber = 0;
    this.nextTrack = 0;
    this.tracks = [];
  }

  /**
   * The codes in a frame, each valid by its checksum: `{ bits, value, rows, columns, corners, trackId }`.
   * `bits` is the payload as `0` and `1`, `value` the same as a BigInt, `corners` the
   * outside of its frame, in image pixels. Pass the viewfinder as `roi`, `{ left, top, right, bottom }`: it bounds the work.
   */
  read(frame, roi = frame.bounds) {
    return this.analyze(frame, roi).filter(({ stage, bits, rows, columns }) => stage === 'validated' &&
      (!this.payloadLengths || this.payloadLengths.has(bits.length)) && (!this.geometries || this.geometries.has(`${rows}x${columns}`)))
      .map(({ bits, rows, columns, outline, trackId }) => ({ bits, value: bits ? BigInt(`0b${bits}`) : null, rows, columns, corners: outline, trackId }));
  }

  /** Everything that looked like a code, with the stage it reached. */
  analyze(frame, roi = frame.bounds) {
    this.frameNumber++;
    const registered = [];
    const raw = [];
    for (const quad of this.coarse.proposals(frame, roi)) {
      const box = boundsOf(quad);
      // A code's outer contour and its inner opening are one code.
      if (raw.some((o) => o.stage === 'validated' && overlap(boundsOf(o.corners), box) >= 0.45)) continue;
      const observation = this.candidate(frame, quad, registered);
      if (observation) raw.push(observation);
    }
    const clusters = [];
    for (const observation of raw) {
      const box = boundsOf(observation.corners);
      const home = clusters.find((cluster) => cluster.some((o) => overlap(box, boundsOf(o.corners)) >= 0.45));
      if (home) home.push(observation); else clusters.push([observation]);
    }
    return clusters.map((cluster) => {
      let selected = cluster[0];
      for (const other of cluster.slice(1)) {
        const deeper = STAGES.indexOf(other.stage) - STAGES.indexOf(selected.stage);
        if (deeper > 0 || (deeper === 0 && (selected.frameScore ?? 0) < (other.frameScore ?? 0))) selected = other;
      }
      return { ...selected, trackId: this.track(boundsOf(selected.corners)) };
    });
  }

  track(box) {
    this.tracks = this.tracks.filter((t) => this.frameNumber <= t.lastFrame + 12);
    let track = this.tracks.find((t) => overlap(box, t.box) >= 0.35);
    if (!track) this.tracks.push((track = { id: ++this.nextTrack }));
    track.box = box;
    track.lastFrame = this.frameNumber;
    return track.id;
  }

  candidate(frame, corners, registered) {
    const rejected = (detail) => ({ stage: 'frame', corners, detail });
    const material = preflight(frame, corners);
    if (!material) return rejected('proposal interior is a single colour');
    if (!hasCornerStep(frame, corners, material)) return rejected('no unique inward corner step');
    const [x0, y0, x1, y1] = boundsOf(corners);
    const crop = {
      left: max(floor(x0 - (x1 - x0) * 0.26), 0), top: max(floor(y0 - (y1 - y0) * 0.26), 0),
      right: min(ceil(x1 + (x1 - x0) * 0.26), frame.width), bottom: min(ceil(y1 + (y1 - y0) * 0.26), frame.height),
    };
    if (crop.right - crop.left < 16 || crop.bottom - crop.top < 16) return null;
    const secondary = this.second.proposals(frame, crop);
    if (!secondary.length) return rejected('wide crop has no second-pass rectangle');
    let selected = null;
    for (const quad of secondary) {
      let known = registered.find((r) => r.quad.every((p, i) => distance(p, quad[i]) <= 1));
      if (!known) registered.push((known = this.register(frame, quad)));
      if (known.sampling && (!selected || samplingPriority(selected.sampling) < samplingPriority(known.sampling))) selected = known;
    }
    if (!selected) return rejected('second-pass rectangle lacks opposite material');
    return { ...judged(selected.sampling), corners: selected.corners, outline: outlineOf(selected) };
  }

  register(frame, quad) {
    const corners = expanded(quad);
    const image = preflight(frame, quad) && rectify(frame, corners);
    return { quad, corners, image, sampling: image ? sampleOnEitherAxis(image, this.shapes) : null };
  }
}

/**
 * Turns per-frame readings into one confirmed code: the same payload on the same track in two frames
 * close together. The checksum is short, so one frame is not enough to act on.
 */
export class Open3DPCStabilizer {
  /** Two sightings further apart than `consistencyMs` are not one look; a confirmed code outlives `retentionMs` unseen. */
  constructor({ consistencyMs = 450, retentionMs = 420 } = {}) {
    Object.assign(this, { consistencyMs, retentionMs });
    this.reset();
  }

  /** Feed every frame's readings, empty ones too, with a monotonic clock. Returns the confirmed code while it is in view. */
  observe(readings, nowMs) {
    if (readings.length > 1) { this.reset(); return null; }
    const [reading] = readings;
    if (reading) {
      const same = this.pending && this.pending.bits === reading.bits && this.pending.trackId === reading.trackId &&
        nowMs > this.lastSeen && nowMs - this.lastSeen <= this.consistencyMs;
      if (same) this.seen++; else { this.seen = 1; this.confirmed = null; }
      this.pending = reading;
      this.lastSeen = nowMs;
      if (this.seen >= 2) this.confirmed = reading;
    }
    if (!this.pending || nowMs - this.lastSeen > this.retentionMs) { this.reset(); return null; }
    return this.confirmed;
  }

  reset() { this.pending = null; this.seen = 0; this.lastSeen = 0; this.confirmed = null; }
}
