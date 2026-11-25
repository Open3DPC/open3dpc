// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
import { bitsFromInteger, encode, raster } from '../open3dpc.js';
import { Frame, Open3DPCReader } from '../open3dpc-reader.js';

const readers = new Map();
onmessage = ({ data: { id, image, roi, still } }) => {
  // A photo must not disturb the codes followed through the camera.
  const key = still ? 'still' : 'camera';
  if (!readers.has(key)) readers.set(key, new Open3DPCReader());
  const started = performance.now();
  const readings = readers.get(key).read(Frame.fromImageData(image), roi);
  postMessage({ id, readings, ms: performance.now() - started });
};

// The first readings of a page run before the browser has compiled the reader and take several times longer.
// So it reads a drawn code while the person is still allowing the camera.
const warm = raster(encode(bitsFromInteger(4242, 14), 4, 6), { scale: 24, quietZone: true });
const picture = { width: 640, height: 640, data: new Uint8ClampedArray(640 * 640 * 4).fill(255) };
const [left, top] = [Math.floor((640 - warm.width) / 2), Math.floor((640 - warm.height) / 2)];
for (let y = 0; y < warm.height; y++) for (let x = 0; x < warm.width; x++) {
  // Sheared a little: a code in the hand is never square to the picture.
  const at = ((y + top + (x >> 4)) * 640 + x + left) * 4;
  picture.data.fill(warm.pixels[y * warm.width + x], at, at + 3);
}
let turns = 8;
(function again() {
  if (readers.size) return; // the camera is on: every moment is the camera's
  new Open3DPCReader().read(Frame.fromImageData(picture));
  if (--turns) setTimeout(again, 20);
})();
