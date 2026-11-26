# Reading Open3DPC in the browser

The [scanner](../generator/scan/) is a page that opens the phone's camera and reads codes; there is nothing to
install, and no picture leaves the device. It needs an `https` address (`localhost` counts) and the viewer's
permission for the camera.

The reader under it is one JavaScript module with no dependencies,
[`open3dpc-reader.js`](../generator/open3dpc-reader.js); it imports `open3dpc.js` beside it and also runs in Node.
Install it with `npm install open3dpc` and import `open3dpc/reader`, or copy the two files.

## Read a picture

```js
import { Frame, Open3DPCReader } from './open3dpc-reader.js';

const reader = new Open3DPCReader({ payloadLengths: [14] });
const readings = reader.read(Frame.fromImageData(context.getImageData(0, 0, width, height)));
readings[0]?.value;                                     // 9999n, a BigInt
```

Set `payloadLengths` and `geometries` for each session: the payload lengths it understands and the shapes it
accepts, as `[rows, columns]`, for example `{ payloadLengths: [14], geometries: [[4, 6]] }`. Anything else is
ignored. Fewer accepted codes means fewer false reads
([why](../README.md#you-decide-what-a-session-reads)).

## Read a camera

Keep one reader per camera and give every frame's readings to a stabilizer. It confirms a code seen twice in
a row; the checksum is too short to act on one frame.

```js
const stabilizer = new Open3DPCStabilizer();
const code = stabilizer.observe(reader.read(frame, viewfinder), performance.now());
if (code) console.log(code.value);
```

`viewfinder` is `{ left, top, right, bottom }` in frame pixels. Read in a worker, crop to the viewfinder
first, and skip the frames that arrive meanwhile: [`scan/scan.js`](../generator/scan/scan.js) and
[`scan/worker.js`](../generator/scan/worker.js) do all three.

## What to expect

It is a port of the Kotlin reader: the same stages and the same [limits](reader-pipeline.md#known-limits-of-the-readers).
Reading speed and distance on phones have not been measured. Light and 2× zoom appear only where the browser
gives them to pages.
