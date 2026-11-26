// Draws every SVG of this folder except the comparisons, from the generator. Run: node docs/img/make.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { darkGrid, encode } from '../../generator/open3dpc.js';

const out = (name, body) => writeFileSync(new URL(name, import.meta.url), body + '\n');
const font = 'font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"';
const code = encode('10011100001111', 4, 6);
const number = (n, bits, h, w) => encode(n.toString(2).padStart(bits, '0'), h, w);

// ---- hero: the code flush in a tile, drawn in axonometric projection
{
  const grid = darkGrid(number(4242, 14, 4, 6));
  const rows = grid.length + 2;
  const columns = grid[0].length + 2;
  const project = (x, y, z) => [(x * 25 - y * 12 + 300).toFixed(1), (x * 5.2 + y * 17 - z * 24 + 70).toFixed(1)];
  const face = (points, fill) => `<path fill="${fill}" d="M${points.map((p) => project(...p).join(' ')).join('L')}Z"/>`;
  const shapes = [
    face([[0, rows, 0], [columns, rows, 0], [columns, rows, -1.6], [0, rows, -1.6]], '#d9452b'),
    face([[columns, 0, 0], [columns, rows, 0], [columns, rows, -1.6], [columns, 0, -1.6]], '#b93720'),
    face([[0, 0, 0], [columns, 0, 0], [columns, rows, 0], [0, rows, 0]], '#ff5a3c'),
  ];
  let dark = '';
  grid.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      let end = c;
      while (row[end]) end++;
      dark += `M${[[c + 1, r + 1], [end + 1, r + 1], [end + 1, r + 2.02], [c + 1, r + 2.02]].map(([x, y]) => project(x, y, 0).join(' ')).join('L')}Z`;
      c = end;
    }
  });
  shapes.push(`<path fill="#fdfcf8" d="${dark}"/>`);
  out('hero.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 430" width="820" height="430" role="img" aria-label="A drawing of a two-color tile with an Open3DPC code holding the number 4242"><rect width="820" height="430" rx="16" fill="#e3e7e3"/><g transform="translate(66 2) scale(.88)">${shapes.join('')}</g></svg>`);
}

// ---- anatomy
{
  const M = 56;
  const x0 = 60;
  const y0 = 64;
  const w = (code.w + 2) * M;
  const h = (code.h + 2) * M;
  const rect = (x, y, width, height, fill, extra = '') => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" ${extra}/>`;
  const colours = { payload: ['#dbeafe', '#1d4ed8'], terminator: ['', '#15803d'], padding: ['#e5e7eb', ''], crc: ['#e5d0fb', '#7e22ce'] };
  const s = [rect(0, 0, 860, 494, '#ffffff', 'rx="12"'),
    rect(x0 - M / 2, y0 - M / 2, w + M, h + M, 'none', 'stroke="#8a918e" stroke-dasharray="6 5"'),
    rect(x0, y0, w, h, '#111'), rect(x0 + M / 2, y0 + M / 2, w - M, h - M, '#fff'), rect(x0 + M / 2, y0 + M / 2, M, M, '#111')];
  code.cells.forEach((row, r) => row.forEach((cell, c) => {
    if (cell.kind === 'orientation') return;
    const x = x0 + (c + 1) * M;
    const y = y0 + (r + 1) * M;
    const label = cell.kind === 'terminator' ? 'T' : cell.kind === 'padding' ? '×' : cell.bit;
    const light = cell.kind === 'terminator' || (cell.kind !== 'padding' && cell.bit === '1');
    s.push(rect(x, y, M, M, colours[cell.kind][Number(cell.bit)]), `<text x="${x + M / 2}" y="${y + M / 2 + 7}" text-anchor="middle" font-size="20" font-family="ui-monospace, Menlo, monospace" fill="${light ? '#fff' : '#111'}">${label}</text>`);
  }));
  const notes = [['#8a918e', 'Quiet zone', 'at least M/2 of contrasting background'], ['#111', 'Frame', 'one closed line, M/2 wide'], ['#111', 'Orientation', 'the one square joined to the frame'],
    ['#1d4ed8', 'Payload', '14 bits: 9999'], ['#15803d', 'Terminator', 'always 1, ends the payload'], ['#c3c7cc', 'Padding', 'zeroes'], ['#7e22ce', 'Checksum', 'last column, top to bottom']];
  notes.forEach(([colour, name, text], i) => {
    const y = 62 + i * 54;
    s.push(rect(570, y - 13, 16, 16, colour, 'rx="3"'), `<text x="598" y="${y}" font-size="17" font-weight="600" fill="#15191a">${name}</text><text x="598" y="${y + 20}" font-size="14" fill="#5d6562">${text}</text>`);
  });
  s.push(`<path d="M${x0} 452h${M}" stroke="#5d6562" stroke-width="2"/><path d="M${x0} 447v10M${x0 + M} 447v10" stroke="#5d6562" stroke-width="2"/><text x="${x0 + M / 2}" y="476" text-anchor="middle" font-size="14" fill="#5d6562">M</text><text x="${x0 + M + 16}" y="457" font-size="14" fill="#5d6562">1.6 mm by default, so the code is 12.8 × 9.6 mm</text>`);
  out('anatomy.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 494" width="860" height="494" ${font} role="img" aria-label="The parts of an Open3DPC code: quiet zone, frame, orientation square, payload, terminator, padding and checksum">${s.join('')}</svg>`);
}

// ---- logo: a real 7 × 34 code whose cells spell OPEN 3DPC, on its M/2 quiet zone
{
  const logo = encode('0000000000000000000000000000000000100110011101100011001100110001101010101010001010000101010101010001010110011001010001001010110010001010100010001010000101010100010000100100011101010011001100100001', 7, 34);
  const grid = darkGrid(logo);
  const path = grid.map((row, r) => row.map((dark, c) => (dark && !row[c - 1] ? `M${c} ${r}h${[...row.slice(c), 0].indexOf(0)}v1H${c}z` : '')).join('')).join('');
  const [w, h] = [grid[0].length, grid.length];
  out('logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${w + 2} ${h + 2}" width="${(w + 2) * 16}" height="${(h + 2) * 16}" shape-rendering="crispEdges" role="img" aria-label="Open3DPC logo: an Open3DPC code whose cells spell OPEN 3DPC"><path fill="#fff" d="M-1-1h${w + 2}v${h + 2}H-1z"/><path fill="#111" d="${path}"/></svg>`);
}

// The icon: the number 0 in ten bits on 4 × 4, a code that can be scanned.
{
  const cells = encode('0'.repeat(10), 4, 4).rows;
  const path = cells.map((row, r) => [...row].map((c, x) => (c === '1' ? `M${2 * x + 2} ${2 * r + 2}h2v2h-2z` : '')).join('')).join('');
  out('icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 14 14" width="448" height="448" shape-rendering="crispEdges" role="img" aria-label="Open3DPC icon: the number 0 as a code"><path fill="#fff" d="M-1-1h14v14H-1z"/><path fill="#111" fill-rule="evenodd" d="M0 0h12v12H0zM1 1v10h10V1z"/><path fill="#111" d="M1 1h2v2H1z${path}"/></svg>`);
}

// ---- the lockup: the icon in orange beside the long logo, for light and for dark pages
{
  const paths = (bits, h, w) => {
    const grid = darkGrid(encode(bits, h, w));
    return grid.map((row, r) => row.map((dark, c) => (dark && !row[c - 1] ? `M${c} ${r}h${[...row.slice(c), 0].indexOf(0)}v1H${c}z` : '')).join('')).join('');
  };
  const long = /encode\('([01]+)', 7, 34\)/.exec(readFileSync(new URL(import.meta.url), 'utf8'))[1];
  const icon = `<g transform="scale(1.25)"><rect width="16" height="16" rx="2.6" fill="#ff5a3c"/><path transform="translate(2 2)" fill="#fff" d="${paths('0'.repeat(10), 4, 4)}"/></g>`;
  for (const [name, paper, ink] of [['light', '#fff', '#111'], ['dark', '#111', '#fff']])
    out(`lockup-${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 98 20" width="784" height="160" shape-rendering="crispEdges" role="img" aria-label="Open3DPC">${icon}<g transform="translate(25 1)"><path fill="${paper}" d="M-1-1h74v20H-1z"/><path fill="${ink}" d="${paths(long, 7, 34)}"/></g></svg>`);
}

// ---- ideas: six objects, each with a real code
{
  const ideas = [[417, 4, 6, '#ff5a3c', '#fff'], [88, 6, 4, '#22302c', '#f6c945'], [12, 4, 4, '#0f6e68', '#f2efe4'], [2048, 4, 6, '#f4f3ee', '#17191a'], [31, 5, 5, '#c9d6f2', '#1f2c55'], [1306, 4, 6, '#25314f', '#fff']];
  const names = ['Filament spools', 'Tool drawers', 'Board games', 'Key tags', 'Moving boxes', 'Printed parts'];
  const tiles = ideas.map(([n, h, w, paper, ink], i) => {
    const grid = darkGrid(number(n, h === 4 && w === 4 ? 9 : 14, h, w));
    const k = 130 / Math.max(grid.length, grid[0].length);
    const [x, y] = [(i % 3) * 276, Math.floor(i / 3) * 236];
    const path = grid.map((row, r) => row.map((dark, c) => (dark && !row[c - 1] ? `M${c} ${r}h${[...row.slice(c), 0].indexOf(0)}v1H${c}z` : '')).join('')).join('');
    return `<rect x="${x}" y="${y}" width="264" height="190" rx="10" fill="${paper}"/><g transform="translate(${x + 132 - (grid[0].length * k) / 2} ${y + 95 - (grid.length * k) / 2}) scale(${k})"><path shape-rendering="crispEdges" fill="${ink}" d="${path}"/></g><text x="${x + 132}" y="${y + 214}" text-anchor="middle" font-size="17" fill="#7d8590">${names[i]}</text>`;
  });
  out('ideas.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 816 460" width="816" height="460" ${font} role="img" aria-label="Six objects with codes: ${names.join(', ').toLowerCase()}">${tiles.join('')}</svg>`);
}

// ---- the nozzle's path: 9999 as the smallest standard QR code and as Open3DPC 4 × 6, 0.8 mm thinnest feature.
// On a 0.2 mm grid every loop runs along the middle of a 0.4 mm line, 0.2, 0.6 and 1.0 mm in from the edge.
{
  // QR version 1, numeric mode, level L, holding 9999: the code in comparison-thinnest-line.svg.
  const qr = ['#######.##..#.#######', '#.....#..#..#.#.....#', '#.###.#.#.#.#.#.###.#', '#.###.#.#..#..#.###.#', '#.###.#.###...#.###.#',
    '#.....#.......#.....#', '#######.#.#.#.#######', '.........##..........', '####..#.#.#..#..###.#', '##...#.##...#..#...##', '#.#.#.##..#.#####..##',
    '.#..##...##.##.....##', '##....##.###.#..#.###', '........##...#.#..##.', '#######...#..##.#.##.', '#.....#..######..#.#.', '#.###.#..###..#..#..#',
    '#.###.#.#....#..#..#.', '#.###.#.#.##.#..###..', '#.....#.#####.#.##.##', '#######.##.##..#.#.#.'].map((r) => [...r].map((c) => (c === '#' ? 1 : 0)));
  const up = (g, k) => g.flatMap((r) => Array.from({ length: k }, () => r.flatMap((v) => Array(k).fill(v))));
  // A square step, as a slicer offsets a rectilinear outline.
  const erode = (g) => g.map((r, y) => r.map((v, x) => {
    if (!v) return 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!g[y + dy]?.[x + dx]) return 0;
    return 1;
  }));
  // The outlines of a region, each a closed list of grid corners with the region on the left.
  const contours = (g) => {
    const next = new Map();
    const key = (x, y) => `${x},${y}`;
    const add = (a, b) => { const k = key(...a); if (!next.has(k)) next.set(k, []); next.get(k).push(b); };
    g.forEach((row, y) => row.forEach((v, x) => {
      if (!v) return;
      if (!g[y - 1]?.[x]) add([x + 1, y], [x, y]);
      if (!g[y + 1]?.[x]) add([x, y + 1], [x + 1, y + 1]);
      if (!row[x - 1]) add([x, y], [x, y + 1]);
      if (!row[x + 1]) add([x + 1, y + 1], [x + 1, y]);
    }));
    const loops = [];
    for (const [k, outs] of next) while (outs.length) {
      let [x, y] = k.split(',').map(Number);
      let dir = null;
      const pts = [[x, y]];
      let [nx, ny] = outs.pop();
      for (;;) {
        const d = [nx - x, ny - y];
        if (!dir || d[0] !== dir[0] || d[1] !== dir[1]) pts.push([x, y]);
        dir = d; x = nx; y = ny;
        if (key(x, y) === k) break;
        const o = next.get(key(x, y));
        const pick = o.length > 1 ? o.findIndex(([a, b]) => dir[0] * (b - y) - dir[1] * (a - x) < 0) : 0;
        [nx, ny] = o.splice(Math.max(0, pick), 1)[0];
      }
      pts.shift();
      loops.push(pts);
    }
    return loops;
  };
  const draw = (grid, quiet, x0, name, size) => {
    let g = erode(up(grid, 4));
    const pad = quiet * 4;
    const w = grid[0].length * 4 + 2 * pad;
    const h = grid.length * 4 + 2 * pad;
    let d = '';
    let total = 0;
    for (let level = 0; level < 3 && g.some((r) => r.includes(1)); level++) {
      for (const pts of contours(g)) { total++; d += `M${pts.map(([x, y]) => `${x + pad} ${y + pad}`).join('L')}Z`; }
      g = erode(erode(g));
    }
    const y0 = 116 - h;
    return { total, svg: `<g transform="translate(${x0} ${y0})"><rect width="${w}" height="${h}" rx="3" fill="#18245f"/><path fill="none" stroke="#e6e8ea" stroke-width="1.55" stroke-linejoin="round" d="${d}"/></g><text x="${x0}" y="132" font-size="9" font-weight="700" fill="#15191a">${total} loops</text><text x="${x0}" y="144" font-size="6.5" fill="#5d6562">${name}, ${size}</text><text x="${x0}" y="155" font-size="6.5" font-weight="600" fill="#15191a">Encoded payload: 9999 (integer)</text>` };
  };
  const a = draw(qr, 4, 8, 'QR version 1', '23.2 × 23.2 mm');
  const b = draw(darkGrid(encode('10011100001111', 4, 6)), 1, 140, 'Open3DPC 4 × 6', '14.4 × 11.2 mm');
  out('nozzle-loops.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 252 162" width="756" height="486" ${font} role="img" aria-label="The path of a 0.4 mm nozzle for 9999: ${a.total} loops in the QR code, ${b.total} in Open3DPC"><rect width="252" height="162" rx="6" fill="#ffffff"/>${a.svg}${b.svg}</svg>`);
}

// ---- one number, many shapes: 9999 as the smallest standard QR code and as Open3DPC from square to long,
// one scale, quiet zone included, 0.8 mm thinnest feature (1.6 mm module). The last has two rows, and a
// two-bit checksum.
{
  const k = 6;                                        // drawing units per millimetre
  const qrGrid = ['#######.##..#.#######', '#.....#..#..#.#.....#', '#.###.#.#.#.#.#.###.#', '#.###.#.#..#..#.###.#', '#.###.#.###...#.###.#',
    '#.....#.......#.....#', '#######.#.#.#.#######', '.........##..........', '####..#.#.#..#..###.#', '##...#.##...#..#...##', '#.#.#.##..#.#####..##',
    '.#..##...##.##.....##', '##....##.###.#..#.###', '........##...#.#..##.', '#######...#..##.#.##.', '#.....#..######..#.#.', '#.###.#..###..#..#..#',
    '#.###.#.#....#..#..#.', '#.###.#.#.##.#..###..', '#.....#.#####.#.##.##', '#######.##.##..#.#.#.'];
  const shapes = [[5, 5], [4, 6], [3, 8], [2, 14]];
  const base = 23.2 * k + 8;                          // the bottom line all codes stand on: below the QR code, the tallest
  let x = 12;
  const parts = [];
  const caption = (name, size, cx, muted) => `<text x="${cx}" y="${base + 22}" font-size="12" font-weight="700" fill="${muted ? '#8b948f' : '#15191a'}">${name}</text><text x="${cx}" y="${base + 38}" font-size="11" fill="#5d6562">${size}</text>`;
  {
    const side = 23.2 * k, m = 0.8 * k;               // QR: 21 modules and a 4-module quiet zone, 0.8 mm each
    let d = '';
    qrGrid.forEach((row, r) => [...row].forEach((c, col) => { if (c === '#') d += `M${x + (col + 4) * m} ${base - side + (r + 4) * m}h${m}v${m}h${-m}z`; }));
    parts.push(`<rect x="${x}" y="${base - side}" width="${side}" height="${side}" fill="#fff" stroke="#d3d8d4"/><path fill="#8b948f" d="${d}"/>`, caption('QR code', 'always a square', x, true));
    x += side + 22;
  }
  for (const [h, w] of shapes) {
    const grid = darkGrid(encode('10011100001111', h, w));
    const cell = 0.8 * k;                             // a half-module
    const W = (grid[0].length + 2) * cell, H = (grid.length + 2) * cell;
    let d = '';
    grid.forEach((row, r) => row.forEach((dark, c) => { if (dark && !row[c - 1]) d += `M${x + (c + 1) * cell} ${base - H + (r + 1) * cell}h${[...row.slice(c), 0].indexOf(0) * cell}v${cell}h${-[...row.slice(c), 0].indexOf(0) * cell}z`; }));
    parts.push(`<rect x="${x}" y="${base - H}" width="${W}" height="${H}" fill="#fff" stroke="#d3d8d4"/><path fill="#131917" d="${d}"/>`, caption(`${h} × ${w}`, `${(W / k).toFixed(1)} × ${(H / k).toFixed(1)} mm`, x));
    x += W + 22;
  }
  const width = Math.ceil(x - 10);
  out('shapes.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${base + 76}" width="${width}" height="${base + 76}" ${font} role="img" aria-label="9999 as a QR code, always a square, and as Open3DPC in four shapes from 5 × 5 to 2 × 14, at one scale"><rect width="${width}" height="${base + 76}" rx="10" fill="#f7f8f6"/><g transform="translate(0 12)">${parts.join('')}<text x="12" y="${base + 58}" font-size="12" font-weight="700" fill="#15191a">Encoded payload: 9999 (integer)</text></g></svg>`);
}
