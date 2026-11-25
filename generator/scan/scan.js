// The browser scanner: camera, viewfinder, one worker that reads.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
import { bitsFromInteger, encode, svg } from '../open3dpc.js';
import { Open3DPCStabilizer } from '../open3dpc-reader.js';
import { phoneBlock } from '../phone.js';

const $ = (id) => document.getElementById(id);
const [scanner, video, overlay, finder] = ['scanner', 'video', 'overlay', 'finder'].map($);
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const stabilizer = new Open3DPCStabilizer({ consistencyMs: 1000, retentionMs: 1000 }); // a slow phone reads few frames a second
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

/** The viewfinder is read at no more than this many pixels a side. */
const FINDER_PIXELS = 720;
/** Around the viewfinder, so that a code near its edge still has its quiet zone. */
const MARGIN = 0.12;

let stream = null;
let busy = false;
let session = 0;
let next = 0;
const waiting = new Map();
worker.onmessage = ({ data }) => { waiting.get(data.id)?.resolve(data); waiting.delete(data.id); };
worker.onerror = (event) => {
  event.preventDefault?.();
  for (const { reject } of waiting.values()) reject(new Error('The reader stopped.'));
  waiting.clear();
  fail('The reader could not start in this browser. Update it, or try another one.');
};
function read(image, roi, still = false) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, image, roi, still }, [image.data.buffer]);
  });
}

function state(value) { scanner.dataset.state = value; }
function fail(text) { stop(); $('message').textContent = text; }

const PROBLEMS = {
  NotAllowedError: 'The camera is blocked for this page. Allow it in the browser’s site settings, then try again.',
  NotFoundError: 'This device has no camera. You can read a photo instead.',
  NotReadableError: 'Another app is using the camera. Close it and try again.',
};

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    fail(window.isSecureContext ? 'This browser gives pages no camera. You can read a photo instead.' : 'The camera needs a secure (https) address.');
    return;
  }
  const mine = ++session;
  $('start').disabled = true;
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (mine !== session) { opened.getTracks().forEach((track) => track.stop()); return; }
    stream = opened;
    video.srcObject = stream;
    await video.play();
    if (mine !== session) return;
    stream.getVideoTracks()[0].addEventListener('ended', () => fail('The camera stopped.'));
    tools();
    resume();
    loop(mine);
  } catch (error) {
    if (mine === session) fail(PROBLEMS[error.name] ?? 'The camera could not start. You can read a photo instead.');
  } finally {
    $('start').disabled = false;
  }
}

function stop() {
  session++;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('tools').hidden = true;
  clear();
  state('idle');
}

function resume() {
  stabilizer.reset();
  $('result').hidden = true;
  state(stream ? 'live' : 'idle');
}

/** Light and zoom, where the camera has them. */
function tools() {
  const [track] = stream.getVideoTracks();
  const can = track.getCapabilities?.() ?? {};
  const apply = (constraint) => track.applyConstraints({ advanced: [constraint] });
  const torch = $('torch');
  torch.hidden = !can.torch;
  torch.setAttribute('aria-pressed', 'false');
  torch.onclick = async () => {
    const on = torch.getAttribute('aria-pressed') !== 'true';
    try { await apply({ torch: on }); torch.setAttribute('aria-pressed', String(on)); } catch { torch.hidden = true; }
  };
  const zoom = $('zoom');
  const base = track.getSettings?.().zoom ?? 1;
  zoom.hidden = !(can.zoom && can.zoom.max >= base * 2);
  zoom.textContent = '2×';
  zoom.onclick = async () => {
    const closer = zoom.textContent === '2×';
    try { await apply({ zoom: closer ? base * 2 : base }); zoom.textContent = closer ? '1×' : '2×'; } catch { zoom.hidden = true; }
  };
  $('tools').hidden = torch.hidden && zoom.hidden;
}

/** How the video covers the screen: screen = video × scale + offset. */
function cover() {
  const box = video.getBoundingClientRect();
  const scale = Math.max(box.width / video.videoWidth, box.height / video.videoHeight);
  return { scale, x: box.left + (box.width - video.videoWidth * scale) / 2, y: box.top + (box.height - video.videoHeight * scale) / 2 };
}

/** The viewfinder with a margin, as pixels; `map` takes them back to the screen. */
function grab() {
  const view = cover();
  const box = finder.getBoundingClientRect();
  const side = box.width / view.scale;
  const left = (box.left - view.x) / view.scale;
  const top = (box.top - view.y) / view.scale;
  const x0 = Math.max(0, left - side * MARGIN);
  const y0 = Math.max(0, top - side * MARGIN);
  const x1 = Math.min(video.videoWidth, left + side * (1 + MARGIN));
  const y1 = Math.min(video.videoHeight, top + side * (1 + MARGIN));
  const shrink = Math.min(1, FINDER_PIXELS / side);
  canvas.width = Math.round((x1 - x0) * shrink);
  canvas.height = Math.round((y1 - y0) * shrink);
  context.drawImage(video, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
  const roi = { left: (left - x0) * shrink, top: (top - y0) * shrink, right: (left + side - x0) * shrink, bottom: (top + side - y0) * shrink };
  const factor = view.scale / shrink;
  return { image: context.getImageData(0, 0, canvas.width, canvas.height), roi, map: ({ x, y }) => ({ x: x * factor + x0 * view.scale + view.x, y: y * factor + y0 * view.scale + view.y }) };
}

const nextFrame = () => new Promise((resolve) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(resolve) : requestAnimationFrame(resolve)));

async function loop(mine) {
  let started = performance.now();
  while (mine === session) {
    await nextFrame();
    if (mine !== session) return;
    if (scanner.dataset.state !== 'live' || busy || video.videoWidth === 0) { started = performance.now(); continue; }
    busy = true;
    try {
      const { image, roi, map } = grab();
      const { readings } = await read(image, roi);
      if (mine !== session || scanner.dataset.state !== 'live') continue;
      outline(readings, map);
      const code = stabilizer.observe(readings, performance.now());
      if (code) { show(code); started = performance.now(); } else {
        $('hint').textContent = readings.length > 1 ? 'Show one code at a time'
          : performance.now() - started > 6000 ? 'Move closer or further, and avoid glare' : 'Fit the code inside the square';
      }
    } catch { /* the worker's own handler tells */ } finally { busy = false; }
  }
}

function clear() { overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); }

function outline(readings, map) {
  const ratio = devicePixelRatio || 1;
  const { width, height, left, top } = overlay.getBoundingClientRect();
  overlay.width = width * ratio;
  overlay.height = height * ratio;
  const ink = overlay.getContext('2d');
  ink.scale(ratio, ratio);
  ink.translate(-left, -top);
  ink.strokeStyle = '#ff5a3c';
  ink.lineWidth = 4;
  ink.lineJoin = 'round';
  for (const { corners } of readings) {
    ink.beginPath();
    for (const point of corners.map(map)) ink.lineTo(point.x, point.y);
    ink.closePath();
    ink.stroke();
  }
}

function show({ bits, value, rows, columns }) {
  const text = value === null ? '(empty)' : String(value);
  $('value').textContent = text;
  $('value').classList.toggle('long', text.length > 9);
  $('facts').textContent = `${bits.length} bits · ${rows} × ${columns} · ${bits.length > 24 ? `${bits.slice(0, 24)}…` : bits}`;
  $('picture').innerHTML = svg(encode(bits, rows, columns));
  $('copy').textContent = 'Copy';
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText(text); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Could not copy'; } };
  $('result').hidden = false;
  if (stream) state('found');
}

async function photo(file) {
  $('message').textContent = 'Reading the photo…';
  try {
    const bitmap = await createImageBitmap(file);
    // The whole photo first, then at half the size: a large code in a sharp photo reads better smaller.
    for (const limit of [2000, 900]) {
      const shrink = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * shrink);
      canvas.height = Math.round(bitmap.height * shrink);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const { readings } = await read(context.getImageData(0, 0, canvas.width, canvas.height), undefined, true);
      if (!readings.length) continue;
      $('message').textContent = readings.length > 1 ? `${readings.length} codes in the photo; this is the first.` : 'Pictures are read on this device and never sent anywhere.';
      show(readings[0]);
      $('result').scrollIntoView({ block: 'nearest' });
      return;
    }
    $('message').textContent = 'No Open3DPC code found in this photo.';
  } catch {
    $('message').textContent = 'This file could not be read as a photo.';
  }
}

$('sample').innerHTML = svg(encode(bitsFromInteger(4242, 14), 4, 6), { quietZone: true });
$('start').addEventListener('click', start);
$('again').addEventListener('click', () => { clear(); resume(); });
$('photo').addEventListener('change', ({ target }) => { if (target.files[0]) photo(target.files[0]); target.value = ''; });
// A page in the background loses the camera anyway; give it back cleanly.
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) stop(); });
for (const element of document.querySelectorAll('[data-phone]')) phoneBlock(element, location.href.replace(/[#?].*$/, ''));
