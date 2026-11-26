import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bitsFromInteger, encode, raster } from 'open3dpc';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'open3dpc-cli-'));
after(() => rmSync(work, { recursive: true, force: true }));

function run(...args) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], { cwd: work, encoding: 'utf8' });
  return { status, out: stdout.trim(), err: stderr.trim() };
}

/** A phone-like photo: the code turned and dimmed on a noisy table, blurred, as JPEG. */
async function photo(path, value, h, w, { angle = 17, size = 380 } = {}) {
  const { width, height, pixels } = raster(encode(bitsFromInteger(value, 14), h, w), { scale: 40, quietZone: true });
  const code = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 1 } })
    .resize(size).linear(0.75, 30).rotate(angle, { background: '#b9b2a6' }).png().toBuffer();
  const table = Buffer.alloc(2400 * 1600 * 3);
  for (let i = 0; i < table.length; i++) table[i] = 150 + ((i * 7919) % 50);
  await sharp(table, { raw: { width: 2400, height: 1600, channels: 3 } })
    .composite([{ input: code, left: 900, top: 600 }]).blur(1.2).jpeg({ quality: 72 }).toFile(path);
}

before(async () => {
  mkdirSync(join(work, 'photos/inner'), { recursive: true });
  await photo(join(work, 'photos/a.jpg'), 4242, 4, 6);
  await photo(join(work, 'photos/inner/b.jpg'), 9999, 6, 4, { angle: -40, size: 260 });
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#888888' } }).jpeg().toFile(join(work, 'photos/empty.jpg'));
  writeFileSync(join(work, 'photos/notes.txt'), 'not a photo');
});

test('scan reads a folder with its subfolders and skips what is not a photo', () => {
  const { status, out } = run('scan', 'photos');
  assert.equal(status, 1, 'one photo has no code');
  assert.deepEqual(out.split('\n'), [
    'photos/a.jpg\t4x6\t4242\t01000010010010',
    'photos/empty.jpg\tno code',
    'photos/inner/b.jpg\t6x4\t9999\t10011100001111',
  ]);
});

test('scan exits 0 when every photo has a code, and --json gives corners in photo pixels', () => {
  const { status, out } = run('scan', 'photos/a.jpg', '--json');
  assert.equal(status, 0);
  const [{ file, codes: [code] }] = JSON.parse(out);
  assert.equal(file, 'photos/a.jpg');
  assert.deepEqual([code.value, code.shape, code.bits], ['4242', '4x6', '01000010010010']);
  for (const [x, y] of code.corners) assert.ok(x > 850 && x < 1400 && y > 550 && y < 1100, `corner ${x},${y} is on the code`);
});

test('scan filters by payload length and shape, and --why says how far a miss got', () => {
  assert.match(run('scan', 'photos/inner/b.jpg', '--shape', '4x6').out, /\tno code$/);
  assert.match(run('scan', 'photos/inner/b.jpg', '--bits', '16').out, /\tno code$/);
  assert.match(run('scan', 'photos/inner/b.jpg', '--shape', '6x4,4x6', '--bits', '14').out, /\t9999\t/);
  assert.equal(run('scan', 'photos/empty.jpg', '--why').out, 'photos/empty.jpg\tno code (nothing shaped like a code)');
});

test('make writes STL and backing by default, the smallest shape first', () => {
  const { status, out } = run('make', '9999', '--out', 'made');
  assert.equal(status, 0);
  assert.deepEqual(out.split('\n'), [
    '9999 · 14 bits · 4x5 · 11.2 x 9.6 mm, 12.8 x 11.2 mm with the quiet zone · module 1.6 mm',
    'made/open3dpc-9999-4x5.stl',
    'made/open3dpc-9999-4x5-backing.stl',
  ]);
  const stl = readFileSync(join(work, 'made/open3dpc-9999-4x5.stl'));
  assert.equal(stl.length, 84 + 50 * stl.readUInt32LE(80), 'a whole binary STL');
});

test('make --png draws a code that scan reads back; nozzle and passes set the module', () => {
  const made = run('make', '600', '--length', '14', '--shape', '4x6', '--png', '--svg', '--nozzle', '0.6', '--passes', '3', '--out', 'png');
  assert.equal(made.status, 0, made.err);
  assert.match(made.out, /module 3\.6 mm/);
  assert.match(readFileSync(join(work, 'png/open3dpc-600-4x6.svg'), 'utf8'), /width="28\.8000mm"/);
  assert.equal(run('scan', 'png/open3dpc-600-4x6.png').out, 'png/open3dpc-600-4x6.png\t4x6\t600\t00001001011000');
  assert.equal(run('make', '--bits', '101101', '--png', '--out', 'png').status, 0);
  assert.equal(run('scan', 'png/open3dpc-101101-2x5.png').out, 'png/open3dpc-101101-2x5.png\t2x5\t45\t101101');
});

test('shapes lists the shapes that hold a payload', () => {
  const lines = run('shapes', '9999').out.split('\n');
  assert.equal(lines[0], '9999 · 14 bits');
  assert.match(lines[1], /^4x5\tchecksum 4 bits\t12\.8 x 11\.2 mm/);
});

test('mistakes exit 2 with one line on stderr', () => {
  for (const args of [[], ['scan'], ['scan', 'missing.jpg'], ['make', 'abc'], ['make', '12', '--shape', '2x3'], ['make', '9', '--bits', '1'], ['scan', 'photos', '--shape', '4by6'], ['fly']]) {
    const { status, err } = run(...args);
    if (!args.length) { assert.equal(status, 0, 'no arguments prints the help'); continue; }
    assert.equal(status, 2, args.join(' '));
    assert.match(err, /^open3dpc: [^\n]+$/, args.join(' '));
  }
});
