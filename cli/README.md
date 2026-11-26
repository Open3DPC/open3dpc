# open3dpc-cli

The `open3dpc` command: read [Open3DPC](https://open3dpc.org) codes from photos and whole folders, and
make the files to print one. It runs on Node.js 20.9 or later, on macOS, Linux and Windows.

```bash
npx open3dpc-cli scan photo.jpg
npm install -g open3dpc-cli      # then just: open3dpc …
```

## Read photos

```bash
open3dpc scan IMG_0412.jpg
open3dpc scan ~/Pictures/parts           # a folder, with its subfolders
open3dpc scan parts --shape 4x6 --bits 14
open3dpc scan parts --json > codes.json
```

One line per code: the file, the shape, the value and the bits. A photo with no code says so, and
`--why` adds how far the best candidate got.

```
parts/IMG_0412.jpg    4x6    4242    01000010010010
parts/IMG_0413.jpg    no code
```

JPEG, PNG, WebP, AVIF, TIFF and GIF are read everywhere. iPhone HEIC photos are read on macOS, which
converts them; elsewhere convert them to JPEG first. A file is taken by its first bytes, not its name:
anything else, an SVG or a PDF renamed `.jpg` included, is refused rather than opened, and pictures over
268 megapixels are refused too. A photo is read whole, then at a smaller size, as
the [scan page](https://open3dpc.org/scan) does.

Set `--shape` and `--bits` to what your codes are: fewer accepted shapes and lengths mean fewer false
reads. `--json` gives each code's corners in the photo's pixels.

The exit status is 0 when every photo has a code, 1 when some have none, and 2 on a mistake in the
command or a file that is not a picture.

## Make a code

```bash
open3dpc make 4242                           # STL of the code and of its backing
open3dpc make 4242 --length 14 --shape 4x6   # the bit length and shape your reader expects
open3dpc make --bits 0110100111 --svg --png
open3dpc make 4242 --nozzle 0.6 --passes 3 --plate 1.2 --out prints
open3dpc shapes 4242                         # the shapes that hold it, smallest first
```

The defaults are the [make page](https://open3dpc.org/make)'s: a 0.4 mm nozzle, two passes in the
thinnest line (a 1.6 mm module), the code 1.5 nozzles high over a 1 mm plate, and the smallest shape
that fits. `--module` and `--height` set the sizes directly.

The two STL files share one origin: load them as one object and give each its filament.

## Licence

Apache 2.0. Images are opened with [sharp](https://sharp.pixelplumbing.com); the code itself is the
[`open3dpc`](https://github.com/Open3DPC/open3dpc) library, which has no dependencies.
