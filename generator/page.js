// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
import * as o from './open3dpc.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const mm = (value) => String(Number(value.toFixed(2)));
let selected = { h: 4, w: 6 };
let larger = false;
let current = null;

const FIELDS = ['mode', 'value', 'bits', 'nozzle', 'passes', 'module', 'height', 'plate', 'maxWidth', 'maxHeight', 'minCrc'];

function restore() {
  const saved = new URLSearchParams(location.hash.slice(1));
  for (const name of FIELDS) if (saved.has(name)) form.elements[name].value = saved.get(name);
  const h = Number(saved.get('h'));
  const w = Number(saved.get('w'));
  if (o.isValidGeometry(h, w)) selected = { h, w };
}
function remember() {
  const state = new URLSearchParams();
  for (const name of FIELDS) if (form.elements[name].value !== '') state.set(name, form.elements[name].value);
  state.set('h', selected.h);
  state.set('w', selected.w);
  try { history.replaceState(null, '', `#${state}`); } catch { /* opened from a file */ }
}
function number(name, label, optional = false) {
  const text = form.elements[name].value.trim();
  if (text === '' && optional) return null;
  const value = Number(text);
  if (text === '' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive number.`);
  return value;
}
const percent = (share) => (share >= 0.01 ? `${Number((share * 100).toPrecision(3))}\u00a0%` : share >= 1e-5 ? `${(share * 100).toPrecision(2)}\u00a0%` : `1 in ${Math.round(1 / share).toLocaleString('en')}`);

function read() {
  const mode = form.elements.mode.value;
  const text = form.elements.value.value.replace(/\s+/g, '');
  const fixedLength = mode === 'integer' ? number('bits', 'Length', true) ?? 0 : 0;
  if (text.length > 512) throw new RangeError('The payload is too long.');
  if (!Number.isInteger(fixedLength) || fixedLength > 512) throw new RangeError('Length must be a whole number of bits, at most 512.');
  let payload = text;
  if (mode === 'integer') payload = o.bitsFromInteger(text, fixedLength);
  else if (!/^[01]+$/.test(text)) throw new TypeError('Bits are one or more 0 and 1.');
  if (payload.length > 512) throw new RangeError('This page makes codes up to 512 bits.');

  const nozzle = number('nozzle', 'Nozzle');
  const passes = Number(form.elements.passes.value);
  const module = number('module', 'Module', true) ?? 2 * passes * nozzle;
  const materialHeight = number('height', 'Code height', true) ?? 1.5 * nozzle;
  return { payload, nozzle, passes, module, materialHeight, plate: number('plate', 'Plate'),
    maxWidth: number('maxWidth', 'Max width', true), maxHeight: number('maxHeight', 'Max height', true),
    minCrc: Number(form.elements.minCrc.value) };
}

function shapesFor({ payload, module, maxWidth, maxHeight, minCrc }) {
  const n = payload.length;
  const base = Math.max(Math.floor(n * 1.2), n + 4 + 2 * minCrc);
  const limit = n <= o.payloadCapacity(o.COMPACT_MAX, o.COMPACT_MAX) && !larger ? o.COMPACT_MAX : null;
  const bound = (mmLimit) => (mmLimit === null ? limit : Math.min(limit ?? Infinity, Math.floor(mmLimit / module + 1e-9) - 3));
  const rows = bound(maxHeight);
  const columns = bound(maxWidth);
  if ((rows !== null && rows < 1) || (columns !== null && columns < 1)) return [];
  return o.candidates(n, { maximumCapacity: larger ? base * 2 + 8 : base, maximumRows: rows, maximumColumns: columns })
    .filter(({ h }) => o.crcWidth(h) >= minCrc)
    .sort((a, b) => (a.h + 3) * (a.w + 3) - (b.h + 3) * (b.w + 3) || b.h - a.h)
    .slice(0, 80);
}

/** Valid patterns over possible patterns: 2^payload values of this length among 2^(data region + CRC). */
const randomPass = (n, { h, w }) => 2 ** (n - (h * w - 1));

function render() {
  let settings;
  let shapes;
  try {
    settings = read();
    shapes = shapesFor(settings);
    if (!shapes.length) throw new RangeError('No shape meets these limits. Relax the size, the checksum or the module.');
    $('error').hidden = true;
  } catch (problem) {
    $('error').textContent = problem.message;
    $('error').hidden = false;
    for (const id of ['stl', 'backing', 'svg', 'png']) $(id).disabled = true;
    current = null;
    return;
  }
  const geometry = shapes.find((s) => s.h === selected.h && s.w === selected.w) ?? shapes[0];
  selected = geometry;
  const { payload, module, materialHeight, plate, nozzle, passes } = settings;
  const code = o.encode(payload, geometry.h, geometry.w);
  current = { code, module, materialHeight, plate };
  for (const id of ['stl', 'backing', 'svg', 'png']) $(id).disabled = false;

  $('canonical').textContent = `${payload} (${payload.length} ${payload.length === 1 ? 'bit' : 'bits'})`;
  const printed = module / 2 / nozzle;
  $('printHint').textContent = `Thinnest line M/2 = ${mm(module / 2)} mm, ${mm(printed)} passes. Module M = ${mm(module)} mm, code height ${mm(materialHeight)} mm.`
    + (printed + 1e-9 < passes ? ` Below the ${passes} passes you asked for: raise M to ${mm(2 * passes * nozzle)} mm.` : '');

  const size = o.physicalSize(geometry.h, geometry.w, module);
  $('preview').innerHTML = o.svg(code, { module, debug: $('debug').checked, quietZone: $('showQuiet').checked });
  $('legend').hidden = !$('debug').checked;
  $('dims').replaceChildren(`${mm(size.width)} × ${mm(size.height)} mm`, Object.assign(document.createElement('small'), { textContent: `${mm(size.quietWidth)} × ${mm(size.quietHeight)} mm with the quiet zone` }));
  const facts = [
    ['Shape', `${geometry.h} rows × ${geometry.w} columns`],
    ['Payload / terminator / padding', `${payload.length} / 1 / ${code.padding.length} bits`],
    ['Checksum', `CRC-${code.crc.length} 0x${o.FULL_POLYNOMIALS[code.crc.length].toString(16).toUpperCase()}`],
    ['Encoded', `${code.dataRegion} ${code.crc}`],
  ];
  $('facts').replaceChildren(...facts.flatMap(([term, text]) => [Object.assign(document.createElement('dt'), { textContent: term }), Object.assign(document.createElement('dd'), { textContent: text })]));

  $('shapes').replaceChildren(...shapes.map((shape) => {
    const s = o.physicalSize(shape.h, shape.w, module);
    const label = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'shape', value: `${shape.h}x${shape.w}`, checked: shape === geometry });
    const card = document.createElement('span');
    card.innerHTML = o.svg(o.encode(payload, shape.h, shape.w), { module, quietZone: true });
    card.append(Object.assign(document.createElement('b'), { textContent: `${shape.h} × ${shape.w}` }),
      Object.assign(document.createElement('span'), { textContent: `${mm(s.quietWidth)} × ${mm(s.quietHeight)}\u00a0mm`, style: 'all:unset' }),
      Object.assign(document.createElement('span'), { textContent: `CRC-${o.crcWidth(shape.h)}, random pass ${percent(randomPass(payload.length, shape))}`, style: 'all:unset' }));
    label.append(input, card);
    return label;
  }));
  $('more').textContent = larger ? 'Show fewer shapes' : 'Show larger shapes';
  remember();
}

function save(data, type, extension, suffix = '') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `open3dpc-${current.code.h}x${current.code.w}${suffix}.${extension}` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const exportOptions = () => ({ module: current.module, quietZone: $('showQuiet').checked });

$('stl').addEventListener('click', () => save(o.stl(current.code, current), 'model/stl', 'stl'));
$('backing').addEventListener('click', () => save(o.backingStl(current.code, current), 'model/stl', 'stl', '-backing'));
$('svg').addEventListener('click', () => save(o.svg(current.code, exportOptions()), 'image/svg+xml', 'svg'));
$('png').addEventListener('click', () => {
  const { width, height, pixels } = o.raster(current.code, { scale: 40, quietZone: $('showQuiet').checked });
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const image = new ImageData(width, height);
  pixels.forEach((value, i) => image.data.set([value, value, value, 255], i * 4));
  canvas.getContext('2d').putImageData(image, 0, 0);
  canvas.toBlob((blob) => save(blob, 'image/png', 'png'));
});
$('more').addEventListener('click', () => { larger = !larger; render(); });
for (const id of ['debug', 'showQuiet']) $(id).addEventListener('change', render);
form.addEventListener('submit', (event) => event.preventDefault());
form.addEventListener('input', (event) => {
  if (event.target.name === 'shape') {
    const [h, w] = event.target.value.split('x').map(Number);
    selected = { h, w };
    const focus = event.target.value;
    render();
    $('shapes').querySelector(`[value="${focus}"]`)?.focus();
    return;
  }
  if (event.target.name === 'mode') convert(event.target.value);
  labels();
  render();
});
/** Switching between a number and bits keeps the payload: the value is rewritten in the other form. */
function convert(mode) {
  const field = form.elements.value;
  const text = field.value.replace(/\s+/g, '');
  try {
    if (mode === 'binary' && /^\d+$/.test(text)) {
      const length = Number(form.elements.bits.value) || 0;
      field.value = o.bitsFromInteger(text, length);
    } else if (mode === 'integer' && /^[01]+$/.test(text)) {
      field.value = BigInt(`0b${text}`).toString();
      form.elements.bits.value = text.length; // the length is part of the payload
    }
  } catch { /* a number longer than its fixed length stays as typed, and the page says why */ }
}
function labels() {
  const binary = form.elements.mode.value === 'binary';
  $('valueLabel').textContent = binary ? 'Bits' : 'Number';
  $('lengthField').hidden = binary;
}
window.addEventListener('hashchange', () => { restore(); labels(); render(); });
restore();
labels();
render();
