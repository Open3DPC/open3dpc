# Open3DPC specification

Open3D Print Code (Open3DPC) is a compact binary visual code for two-color
3D-printed objects. Why it looks the way it does is in
[docs/concept.md](../docs/concept.md); this directory is the normative part.

| Document | Status | Purpose |
|---|---|---|
| [v2.md](v2.md) | Normative | Physical geometry, quiet zone, bit layout, terminator, CRC, rendering, export, scanner contract |
| [profiles.md](profiles.md) | Normative | Application layer: the payload length as a namespace, dispatch rules |
| [vectors/v2.json](vectors/v2.json) | Normative test data | Generator and scanner conformance vectors |

`v2.md` is the source of truth for the physical format. An application profile
MUST NOT change any of its geometry, traversal, terminator, padding or CRC
rules, and MUST NOT decide anything by geometry.

**Layering rule.** A decoder MUST validate the physical layer, CRC and
terminator included, before the application layer selects a profile by payload
length. A successful physical decode does not imply that the length is
registered, or that a value of that length is valid.

## Terminology

- **module (`M`)**: the side length of one logical matrix cell.
- **matrix**: the `H × W` logical cell grid, with zero-based indices
  `[row,column]`. Height always comes first.
- **data region**: payload, terminator and zero padding, in that order;
  `dataRegionLength` bits.
- **terminator**: the mandatory `1` bit after the payload; the last `1` of the
  data region.
- **padding**: the zero bits after the terminator; may be empty.
- **payload capacity**: `dataRegionLength − 1`; the most payload bits a geometry
  carries.
- **orientation feature**: an `M × M` dark square connected to the outer frame,
  which establishes the normalized top-left corner.
- **quiet zone**: the band of contrasting background, at least `M/2` wide,
  around the frame. It belongs to the object, not to the code's stated size.
- **full polynomial**: a CRC polynomial integer that explicitly includes the
  leading `x^N` and constant `1` terms.

All requirements use RFC 2119 meanings for MUST, MUST NOT, SHOULD and MAY.

## A worked example

The number 9999 is fourteen bits: `10011100001111`. On a `4 × 6` matrix (four
rows, six columns):

```text
C                = min(4, 10)      = 4
dataRegionLength = 4 × 6 − 4 − 1   = 19
payloadCapacity  = 19 − 1          = 18
DATA_REGION      = 10011100001111 || 1 || 0000
CRC-4 (0x13)     = 1101
```

```text
O10011
110001
011110
100001
```

`O` is the orientation feature. The last column is the CRC, top to bottom; every
other cell is the data region in row-major order. With `M = 1.6 mm` the code is
`12.8 × 9.6 mm`, and `14.4 × 11.2 mm` with the minimum quiet zone.

## Licence

The specification text is licensed under [CC BY 4.0](../LICENSE-docs). The test
vectors are licensed under [Apache 2.0](../LICENSE).
