#!/usr/bin/env node
// open3dpc: read Open3DPC codes from photos and make codes to print, from the command line.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  COMPACT_MAX, DEFAULT_MATERIAL_HEIGHT_MM, DEFAULT_MODULE_MM, backingStl, bitsFromInteger, candidates, crcWidth,
  encode, payloadCapacity, physicalSize, raster, stl, svg,
} from 'open3dpc';
import { Frame, Open3DPCReader } from 'open3dpc/reader';

const HELP = `open3dpc: read Open3DPC codes from photos, make codes to print.

  open3dpc scan <photo or folder>...   the codes in photos; folders are read with their subfolders
      --json            one JSON document instead of lines
      --bits 14,16      accept only these payload lengths
      --shape 4x6,6x4   accept only these shapes (rows x columns)
      --why             for a photo without a code, how far the best candidate got

  open3dpc make <number>                files to print a code that holds a number
  open3dpc make --bits 0110...          the same for bits written out
      --length 14       write the number in exactly this many bits (as your reader expects)
      --shape 4x6       rows x columns; default: the smallest shape that fits
      --nozzle 0.4      nozzle, mm (default 0.4)
      --passes 2        nozzle passes in the thinnest line (default 2); module = nozzle x passes x 2
      --module 1.6      module, mm: overrides nozzle and passes
      --height 0.6      height of the code above the plate, mm (default 1.5 x nozzle)
      --plate 1         plate under the backing, mm (default 1)
      --stl --backing --svg --png    which files (default: STL and backing)
      --quiet-zone      SVG and PNG with the light margin around the code
      --out <folder>    where to write (default: here)

  open3dpc shapes <number> | --bits ...   the shapes that hold this payload, smallest first

Exit status: 0 when every photo has a code, 1 when some have none, 2 on a usage or file error.
More: https://open3dpc.org`;

/** A path to print: relative when it is under the current folder. */
const shown = (path) => { const near = relative(process.cwd(), path); return near && !near.startsWith('..') ? near : path; };

const PHOTO = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff', '.gif', '.bmp']);

class Usage extends Error {}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return console.log(HELP), 0;
  if (command === '--version' || command === '-v') return printVersion();
  const run = { scan, make, shapes }[command];
  if (!run) throw new Usage(`Unknown command "${command}". Try: open3dpc --help`);
  return run(rest);
}

function printVersion() {
  console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version);
  return 0;
}

// ---------------------------------------------------------------- scan

async function scan(argv) {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean' }, bits: { type: 'string' }, shape: { type: 'string' }, why: { type: 'boolean' },
  });
  if (!positionals.length) throw new Usage('Name a photo or a folder: open3dpc scan photo.jpg');
  const options = {
    payloadLengths: values.bits ? list(values.bits, (s) => whole(s, '--bits')) : null,
    geometries: values.shape ? list(values.shape, shapeOf) : null,
  };
  const files = positionals.flatMap(photosIn);
  if (!files.length) throw new Usage('No photos there (.jpg, .png, .heic and the like).');

  const results = [];
  for (const file of files) {
    const result = await readPhoto(file, options, values.why);
    results.push(result);
    if (!values.json) console.log(line(result));
  }
  if (values.json) console.log(JSON.stringify(results.map(({ file, codes, error, why }) => ({ file, codes, error, why })), null, 2));
  if (results.some((r) => r.error)) return 2;
  return results.every((r) => r.codes.length) ? 0 : 1;
}

/** A file stays a file; a folder becomes its photos, subfolders included, in name order. */
function photosIn(path) {
  let info;
  try { info = statSync(path); } catch { throw new Usage(`No such file or folder: ${path}`); }
  if (!info.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .flatMap((entry) => (entry.isDirectory() ? photosIn(join(path, entry.name)) : PHOTO.has(extname(entry.name).toLowerCase()) ? [join(path, entry.name)] : []));
}

/** As the scan page does: the whole photo at 2000 px first, then at 900 px — a large sharp code reads better smaller. */
async function readPhoto(file, options, why) {
  let source;
  try { source = await decodable(file); } catch (error) { return { file, codes: [], error: error.message }; }
  const best = { stage: null };
  try {
    const picture = source.path ?? file;
    const meta = await sharp(picture).metadata();
    const fullWidth = meta.autoOrient?.width ?? (meta.orientation >= 5 ? meta.height : meta.width);
    for (const limit of [2000, 900]) {
      const { data, info } = await sharp(picture).rotate()
        .resize(limit, limit, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const frame = Frame.fromImageData({ data, width: info.width, height: info.height });
      const back = fullWidth / info.width;
      const codes = new Open3DPCReader(options).read(frame);
      if (codes.length) {
        return { file, codes: codes.map(({ bits, value, rows, columns, corners }) => ({
          value: value === null ? null : String(value), bits, shape: `${rows}x${columns}`,
          corners: corners.map(({ x, y }) => [Math.round(x * back), Math.round(y * back)]),
        })) };
      }
      if (why) remember(best, new Open3DPCReader().analyze(frame));
    }
    return { file, codes: [], ...(why ? { why: best.stage ? `${best.stage}${best.detail ? `: ${best.detail}` : ''}` : 'nothing shaped like a code' } : {}) };
  } catch (error) {
    return { file, codes: [], error: `could not read it as a picture (${error.message})` };
  } finally {
    source.cleanup?.();
  }
}

const STAGES = ['frame', 'sampling', 'geometry', 'ambiguousCell', 'orientation', 'crc', 'emptyDataRegion', 'validated'];
function remember(best, observations) {
  for (const o of observations) if (STAGES.indexOf(o.stage) > STAGES.indexOf(best.stage)) Object.assign(best, { stage: o.stage, detail: o.detail });
}

/**
 * The file itself, or for an iPhone HEIC that this build of sharp cannot open, a JPEG copy made by macOS `sips`.
 */
async function decodable(file) {
  try {
    // Opening the header is not enough: sharp reads an iPhone HEIC's header and then cannot decode it.
    await sharp(file).resize(8, 8).raw().toBuffer();
    return {};
  } catch (error) {
    if (!['.heic', '.heif'].includes(extname(file).toLowerCase())) throw new Error(`could not read it as a picture (${error.message})`);
    if (process.platform !== 'darwin') throw new Error('HEIC photos need macOS, or convert them to JPEG first');
    const folder = mkdtempSync(join(tmpdir(), 'open3dpc-'));
    const path = join(folder, `${basename(file, extname(file))}.jpg`);
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', file, '--out', path], { stdio: 'ignore' });
    } catch {
      rmSync(folder, { recursive: true, force: true });
      throw new Error('could not convert this HEIC photo');
    }
    return { path, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
  }
}

function line({ file, codes, error, why }) {
  const name = shown(file);
  if (error) return `${name}\terror: ${error}`;
  if (!codes.length) return `${name}\tno code${why ? ` (${why})` : ''}`;
  return codes.map((c) => `${name}\t${c.shape}\t${c.value ?? '(empty)'}\t${c.bits}`).join('\n');
}

// ---------------------------------------------------------------- make

const MAKE_OPTIONS = {
  bits: { type: 'string' }, length: { type: 'string' }, shape: { type: 'string' },
  nozzle: { type: 'string' }, passes: { type: 'string' }, module: { type: 'string' }, height: { type: 'string' }, plate: { type: 'string' },
  stl: { type: 'boolean' }, backing: { type: 'boolean' }, svg: { type: 'boolean' }, png: { type: 'boolean' },
  'quiet-zone': { type: 'boolean' }, out: { type: 'string' },
};

function payloadOf(values, positionals) {
  if (values.bits !== undefined && positionals.length) throw new Usage('Give a number or --bits, not both.');
  if (values.bits !== undefined) {
    if (!/^[01]+$/.test(values.bits)) throw new Usage('--bits is one or more 0 and 1.');
    if (values.length !== undefined) throw new Usage('--length is for a number; --bits is already written out.');
    return { payload: values.bits, label: values.bits };
  }
  if (positionals.length !== 1) throw new Usage('Give one number, or --bits 0110...');
  const text = positionals[0];
  if (!/^\d+$/.test(text)) throw new Usage(`"${text}" is not a whole number. For bits use --bits.`);
  const length = values.length === undefined ? 0 : whole(values.length, '--length');
  try { return { payload: bitsFromInteger(text, length), label: text.replace(/^0+(?=\d)/, '') }; } catch (error) { throw new Usage(error.message); }
}

/** As the make page orders them: least area with the quiet zone, then more rows. */
function shapesFor(payload, minCrc = 0) {
  const n = payload.length;
  const limit = n <= payloadCapacity(COMPACT_MAX, COMPACT_MAX) ? COMPACT_MAX : null;
  return candidates(n, { maximumCapacity: Math.max(Math.floor(n * 1.2), n + 4 + 2 * minCrc), maximumRows: limit, maximumColumns: limit })
    .filter(({ h }) => crcWidth(h) >= minCrc)
    .sort((a, b) => (a.h + 3) * (a.w + 3) - (b.h + 3) * (b.w + 3) || b.h - a.h);
}

function make(argv) {
  const { values, positionals } = parse(argv, MAKE_OPTIONS);
  const { payload, label } = payloadOf(values, positionals);
  const shape = values.shape ? shapeOf(values.shape) : null;
  const fitting = shapesFor(payload)[0] ?? candidates(payload.length, { maximumCapacity: payload.length * 4 + 24 })[0];
  if (!shape && !fitting) throw new Usage('No shape holds this payload; name one with --shape.');
  const [h, w] = shape ?? [fitting.h, fitting.w];
  let code;
  try { code = encode(payload, h, w); } catch (error) { throw new Usage(`${h}x${w}: ${error.message} It holds ${Math.max(payloadCapacity(h, w), 0)} bits; the payload is ${payload.length}.`); }

  const nozzle = values.nozzle === undefined ? 0.4 : positive(values.nozzle, '--nozzle');
  const passes = values.passes === undefined ? 2 : whole(values.passes, '--passes');
  const module = values.module === undefined ? (values.nozzle || values.passes ? 2 * passes * nozzle : DEFAULT_MODULE_MM) : positive(values.module, '--module');
  const materialHeight = values.height === undefined ? (values.nozzle ? 1.5 * nozzle : DEFAULT_MATERIAL_HEIGHT_MM) : positive(values.height, '--height');
  const plate = values.plate === undefined ? 1 : positive(values.plate, '--plate');
  const quietZone = Boolean(values['quiet-zone']);
  const wanted = ['stl', 'backing', 'svg', 'png'].filter((kind) => values[kind]);
  const kinds = wanted.length ? wanted : ['stl', 'backing'];

  const folder = resolve(values.out ?? '.');
  mkdirSync(folder, { recursive: true });
  const stem = join(folder, `open3dpc-${label.length > 24 ? `${payload.length}bits` : label}-${h}x${w}`);
  const files = {
    stl: () => [`${stem}.stl`, stl(code, { module, materialHeight })],
    backing: () => [`${stem}-backing.stl`, backingStl(code, { module, materialHeight, plate })],
    svg: () => [`${stem}.svg`, svg(code, { module, quietZone })],
    png: () => [`${stem}.png`, pngOf(code, quietZone)],
  };
  const size = physicalSize(h, w, module);
  console.log(`${label} · ${payload.length} bits · ${h}x${w} · ${fmt(size.width)} x ${fmt(size.height)} mm, ${fmt(size.quietWidth)} x ${fmt(size.quietHeight)} mm with the quiet zone · module ${fmt(module)} mm`);
  return Promise.all(kinds.map(async (kind) => {
    const [path, data] = files[kind]();
    writeFileSync(path, await data);
    return path;
  })).then((paths) => {
    for (const path of paths) console.log(shown(path));
    return 0;
  });
}

function pngOf(code, quietZone) {
  const { width, height, pixels } = raster(code, { scale: 40, quietZone });
  return sharp(Buffer.from(pixels), { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function shapes(argv) {
  const { values, positionals } = parse(argv, { bits: { type: 'string' }, length: { type: 'string' } });
  const { payload, label } = payloadOf(values, positionals);
  console.log(`${label} · ${payload.length} bits`);
  for (const { h, w } of shapesFor(payload).slice(0, 20)) {
    const size = physicalSize(h, w);
    console.log(`${h}x${w}\tchecksum ${crcWidth(h)} bits\t${fmt(size.quietWidth)} x ${fmt(size.quietHeight)} mm at ${DEFAULT_MODULE_MM} mm`);
  }
  return 0;
}

// ---------------------------------------------------------------- small things

function parse(argv, options) {
  try { return parseArgs({ args: argv, options, allowPositionals: true, strict: true }); } catch (error) { throw new Usage(error.message); }
}
const list = (text, each) => text.split(',').map((s) => s.trim()).filter(Boolean).map(each);
function whole(text, name) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Usage(`${name} must be a whole number above zero.`);
  return value;
}
function positive(text, name) {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Usage(`${name} must be a positive number.`);
  return value;
}
function shapeOf(text) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(text.trim());
  if (!match) throw new Usage(`"${text}" is not a shape: write rows x columns, like 4x6.`);
  return [Number(match[1]), Number(match[2])];
}
const fmt = (mm) => String(Number(mm.toFixed(2)));

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof Usage)) throw error;
  console.error(`open3dpc: ${error.message}`);
  process.exitCode = 2;
}
