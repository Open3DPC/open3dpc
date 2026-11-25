// Draws logo.svg, hero.svg and anatomy.svg from the generator. Run: node docs/img/make.mjs
import { writeFileSync } from 'node:fs';
import { darkGrid, encode } from '../../generator/open3dpc.js';

const out = (name, body) => writeFileSync(new URL(name, import.meta.url), body + '\n');
const font = 'font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"';
const code = encode('10011100001111', 4, 6);

// ---- hero: the code flush in a tile, drawn in axonometric projection
{
  const grid = darkGrid(code);
  const rows = grid.length + 2;
  const columns = grid[0].length + 2;
  const project = (x, y, z) => [(x * 25 - y * 12 + 300).toFixed(1), (x * 5.2 + y * 17 - z * 24 + 70).toFixed(1)];
  const face = (points, fill) => `<path fill="${fill}" d="M${points.map((p) => project(...p).join(' ')).join('L')}Z"/>`;
  const shapes = [
    face([[0, rows, 0], [columns, rows, 0], [columns, rows, -1.6], [0, rows, -1.6]], '#c9c6bd'),
    face([[columns, 0, 0], [columns, rows, 0], [columns, rows, -1.6], [columns, 0, -1.6]], '#aeaba2'),
    face([[0, 0, 0], [columns, 0, 0], [columns, rows, 0], [0, rows, 0]], '#f6f4ee'),
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
  shapes.push(`<path fill="#1b2022" d="${dark}"/>`);
  out('hero.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 430" width="820" height="430" role="img" aria-label="A drawing of a two-colour tile with an Open3DPC code holding the number 9999"><rect width="820" height="430" rx="16" fill="#dfe4dc"/><g transform="translate(66 2) scale(.88)">${shapes.join('')}</g></svg>`);
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

// ---- logo: a real 5 × 16 code whose cells spell 3DPC, on its M/2 quiet zone
{
  const logo = encode('0110011001110100001010101010100110010101110100001010101000100110011001000', 5, 16);
  const grid = darkGrid(logo);
  const path = grid.map((row, r) => row.map((dark, c) => (dark && !row[c - 1] ? `M${c} ${r}h${[...row.slice(c), 0].indexOf(0)}v1H${c}z` : '')).join('')).join('');
  const [w, h] = [grid[0].length, grid.length];
  out('logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${w + 2} ${h + 2}" width="${(w + 2) * 16}" height="${(h + 2) * 16}" shape-rendering="crispEdges" role="img" aria-label="Open3DPC logo: an Open3DPC code whose cells spell 3DPC"><path fill="#fff" d="M-1-1h${w + 2}v${h + 2}H-1z"/><path fill="#111" d="${path}"/></svg>`);
}
