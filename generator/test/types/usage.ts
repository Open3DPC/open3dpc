// Checked by TypeScript in CI (`tsc -p generator/test/types`): the declarations describe how the package is used.
import { encode, bitsFromInteger, candidates, physicalSize, svg, stl, backingStl, raster, decode } from 'open3dpc';
import { Frame, Open3DPCReader, Open3DPCStabilizer, type Reading } from 'open3dpc/reader';

const code = encode(bitsFromInteger(9999, 14), 4, 6);
const rows: string[] = code.rows;
const shapes: { h: number; w: number }[] = candidates(14);
const size: number = physicalSize(code.h, code.w).quietWidth;
const drawing: string = svg(code, { quietZone: true });
const files: Uint8Array[] = [stl(code, { materialHeight: 0.6 }), backingStl(code, { plate: 1 })];
const decoded = decode(rows);
if (!decoded.error) console.log(decoded.payload, decoded.h, decoded.w);

const { width, height, pixels } = raster(code, { scale: 12, quietZone: true });
const rgba = new Uint8ClampedArray(width * height * 4);
pixels.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
const frame = Frame.fromImageData({ data: rgba, width, height });

const reader = new Open3DPCReader({ payloadLengths: [14], geometries: [[4, 6]] });
const stabilizer = new Open3DPCStabilizer();
const readings: Reading[] = reader.read(frame, frame.bounds);
const confirmed: Reading | null = stabilizer.observe(readings, 0);
const value: bigint | null | undefined = confirmed?.value;
console.log(size, drawing.length, files.length, value);
