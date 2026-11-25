// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
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
