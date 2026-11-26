# How the readers work

The format is permissive about what a code may look like, so the reader carries the
burden of proving that a rectangle in a camera frame really is one. This is the
sequence the libraries follow, and why each stage exists. Cheap, scale-free evidence
runs first; anything that costs a render runs only on what survives.

The numbers below are the constants in the code. Where a number is called measured, it
was measured on synthetic rasters, not on printed parts.

## 1. Region of interest

The visible viewfinder is transformed into capture coordinates and rectangle
detection is constrained to it.

*Why:* it bounds the work per frame, and it stops the scanner locking onto a code
the user is not aiming at, which matters when several codes sit side by side.

## 2. Coarse proposals

A contour detector (`ContourQuads`): connected regions under a local threshold, their hull reduced to four
sides. Aspect ratio from 0.08, minimum size 0.045, up to 48 observations, quadrature tolerance 35.

The Swift reader has a second detector with the same limits, Vision's `VNDetectRectanglesRequest`. A frame is
searched one way; a frame that read no accepted code hands over to the other, and a still picture gets both.

*Why both:* on 292 lab captures contours read 37 codes that Vision missed and missed 28 that Vision read. Vision's
quadrilateral sits 0.2 to 0.4 `M` outside the frame of a small code, where the corner step of stage 3 looks at the
margin and refuses it.

*Why:* the detector is a proposal generator, nothing more. Geometry is inferred later,
so the aspect range is deliberately wide rather than tuned to any profile. The
high observation limit exists because a printed page contains many rectangles —
browser chrome, other codes, page edges, and the real frame must not be crowded
out of the results.

## 3. Two cheap gates on the luma plane

Read directly from the Y plane of the camera buffer, with no render.

- **Opposite interior material**, the quadrilateral must contain two brightness
  populations separated by at least 28 levels. Rejects solid labels, tray walls
  and page edges.
- **Single corner step**, exactly one corner where material runs inward markedly
  further than at the other three (at least 1.6× the runner-up).

*Why the second one is the good gate:* the orientation feature extends `M` past a
frame of `M/2`, so its corner carries about three times the inward material run
of a plain corner. That is a **ratio**, so it holds at any distance and needs no
estimate of `M`. It is the cheapest strong evidence that a rectangle is one of
ours, and it holds whether the detector found the outer contour or the inner
opening.

*Why here:* everything below costs a second detection pass and a perspective
render per candidate.

## 4. Wide crop and a second detection pass

Crop the coarse bounds outset by 26% and detect rectangles again inside it.

*Why:* the first quadrilateral may be a skewed page edge or a partial contour.
Only a second-pass quadrilateral is permitted to define a perspective transform,
so a bad coarse contour can never turn a usable crop into a warped raster before
the physical checks begin. The wide crop is axis-aligned and preserves the source
perspective for exactly that reason.

## 5. Registration margin

Each surviving quadrilateral is expanded outward by 8% of its shortest side
before rectification, offsetting every edge along its normal and re-intersecting
so the shape is preserved.

*Why:* the registration budget is severely asymmetric. Measured on conformant
synthetic rasters with a known quadrilateral displaced by a known amount, a crop 0.2 `M`
too tight has already clipped the outer frame and nothing downstream recovers it;
a crop a whole module too loose costs nothing, because frame refinement (stage 6)
exists to find the true ring inside a margin. Detectors aim at the outer contour,
which puts the pipeline at the very edge of the cliff. Aiming at the middle of
the band instead is free and multiplies the usable tolerance.

## 6. Outer-frame refinement

In the rectified raster, locate the material ring independently of the crop
boundary: build a **graded** threshold field across the raster, enumerate
candidate frame lines per side ordered outermost-first, score each over whole
edges, and take the innermost structurally sound ring.

*Why graded:* scene illumination has a gradient across a printed part; one flat
threshold loses a frame edge to shadow.

*Why enumerate rather than take the strongest line:* a uniform crop boundary
scores a perfect line for whichever polarity it happens to match. When the
detector proposes the card a code is printed on rather than the code, that
boundary wins every time and the real frame a few dozen pixels inside is never
considered. Enumerating lets the ring search step inward.

*Why the ends of each side are checked:* a full row of dark cells is as straight as a side of the frame
and nearly as long. But it stops at the `M/2` gap, and a frame side reaches its neighbours. A ring keeps
its place only if at least seven of its eight side ends are material where that gap would be.

*Why whole edges:* isolated modules, glyph strokes and a filled rectangle cannot
score a four-sided ring with an opposite-color interior.

## 7. Structural measurement, per polarity

Both dark-on-light and light-on-dark are attempted; the format does not fix which
material is the marked one, and a printed part uses whatever two materials it has.

Per polarity the scanner measures frame thickness on each side from sub-pixel
transitions taken along several rays and reduced by median, then the module scale,
then scores each of the four corners for a frame-attached `M × M` block. Exactly
one corner must qualify; that corner is the orientation feature and it fixes the
normalized frame.

*Why several rays and a median:* one probe per edge lets the fused orientation
corner, a rounded corner or a print blemish set the measurement for the whole side.

The module itself is the distance from the frame's inner edge to the feature's far edge, measured
along three rays across the feature on each axis. Both edges turn material into background, so blur,
glare or a bright screen moves them the same way and their distance stays `M`. Thickness (`M/2`) and
the corner block (`1.5M`) are runs of material: glare shrinks them, and a module taken from them came
out short. When the feature cannot be measured, the module falls back to them.

*Why it matters:* a row of dark cells from edge to edge has no borders to count, so its length comes
from the module. A short module made such a code longer: under glare `2×11` read as `2×13` and `3×7`
as `3×9`, and a short CRC let one in four or eight of those through.

## 8. Geometry hypotheses

Enumerate `H × W` within ±1 of the estimate, keeping a hypothesis when **either
the observed shape or its transpose** satisfies the protocol's capacity rule.

The estimate is taken across the opening inside the frame, `(W + 1) × (H + 1)` modules, not across
the whole frame: both edges of the opening move with the material, while the frame's outside grows
and shrinks with it.

*Why the transpose:* capacity is derived from *normalized* height. A physical
`3×5` seen portrait enumerates as `5×3`, whose payload capacity of 8 fails the
CRC-5 floor of 10, so without this every quarter-turned code is discarded
before rotation normalization ever runs.

**When the session names its shapes** (`geometries`), the hypotheses are those shapes, each also
turned a quarter, and nothing else; the estimate is not used. Each shape gives its own module from the
frame: glare that thins the frame shrinks the outside and widens the opening by the same amount, so
`(width + opening) / (2W + 3)` holds still where a module measured from a run of material comes out
short. A shape is kept only while that module, across and down, agrees within 35 % (perspective) and
stays near the measured one: within 12 % of a module measured between two edges of one kind, or 0.9 to
1.6 times one measured from a run of material, since glare only shortens those. A shape one row too
many gives a module shorter than glare explains, so the hint never forces a code into a shape it does
not have; the checksum still decides. The marker must still be the only one at the shape's module, but
need not have been found at the measured one. In the glare sweep of `generator/test/reader.test.js` this
reads about a tenth more codes with no wrong read, and a code told a shape one row or column off reads
as nothing.

## 9. Per-hypothesis scoring

For each candidate geometry the module is `width / (W + 2)` exactly, derived from
the committed lattice rather than from any earlier estimate. Then:

- outer-frame continuity, required at ≥ 0.76
- the `M/2` band between the orientation feature and cells `[0,1]` / `[1,0]`
- every `M/2` quiet band around the lattice
- per-cell classification confidence, with an explicit *ambiguous* outcome

```
structuralScore = 0.45·frame + 0.25·marker + 0.20·quiet + 0.10·lowestConfidence
```

*Why re-check the quiet bands here:* the same three points are cheaper to test
earlier, but only here is the module exact. Rejecting on the earlier estimate
pre-empts stronger evidence with a weaker version of itself.

## 10. Ambiguity, and how it is settled

If the two best hypotheses disagree on geometry and their scores are within 0.06,
the candidate is reported **ambiguous**, unless the leader beats the runner-up by
at least 0.10 on its least confident cell.

*Why the tie exists:* a crop carrying margin ties a code against the same code
read one column wider, and the surplus columns are background, which is a
*perfect* outer frame, a perfect marker and a perfect quiet band. Both hypotheses
score 1.000 on all three. Scoring the quiet bands harder, the intuitive fix,
measurably changes nothing.

*Why cell confidence settles it:* the wider hypothesis has to classify background
as payload, so it is the only term that separates them: 1.000 against 0.600 in
the measured case. Weighted at a tenth, that 0.40 gap arrives as 0.04 against a
0.06 threshold, and a structurally perfect and correct reading was being discarded
for a rival it beat decisively on the only evidence about their disagreement.
Ambiguity is still reported whenever the cells cannot separate them either.

*When the cells cannot settle it either*, the measured module may: the lattice whose module is within 8 % of
it wins, if the next best is at least 4 points further off. The module is measured on the orientation corner
(from the frame's inner edge to the feature's far edge, stage 7), independently of any lattice. A dark row or
column from edge to edge has no cell borders to count and needs this. When the feature could not be measured and
the module is only the frame's thickness, the tie stays a tie: glare moves that measurement.

## 11. Protocol validation

Orientation normalization, then CRC, then the terminator.

*Why it is last:* **CRC never influences registration.** No cell is ever moved,
and no lattice is ever preferred, because doing so produced a checksum that
passed. A format with detection and no correction must not be allowed to search
for an answer it likes.

After the CRC passes, the scanner finds the last `1` of the data region. No
`1` at all is a blank matrix and is rejected here, before any profile: its
CRC is zero and would pass. The bits before that `1` are the payload; their
count is what the next stage dispatches on.

## 12. Application profile

The payload and its length are handed to the application layer, which looks
the length up in its own [profiles](../spec/profiles.md) and either rejects the scan or
runs exactly one profile. A successful physical decode does not imply that a
length is registered, or that an unknown or reserved profile value is valid.

## 13. Clustering and tracking

Overlapping proposals (IoU ≥ 0.45) collapse to one candidate per cluster, keeping
the member that reached the deepest stage. Candidates are tracked across frames by
bounds overlap (IoU ≥ 0.35) with a twelve-frame miss grace.

*Why:* detectors routinely return nested versions of one printed frame. Without
clustering, alternative registrations of a single code become several codes.

## 14. Confirmation

A code becomes an application action only after two observations of one spatial
track (`Open3DPCStabilizer` in both libraries).

*Why:* a single frame's misregistration should never become a user-visible action.
A CRC cannot notice a neighbouring code, which is a perfectly valid one.

The pre-geometry gates derive the module as twice the measured frame thickness, which is
unreliable on printed material. Stage 9 recovers the scale exactly; stages 7 and 8 do not.

## Known limits of the readers

On perfect synthetic pictures the readers still refuse some codes. They did not return a wrong payload
in the tests of the two paragraphs below.

Of the ten pictures in `spec/fixtures`, each at 0, 3, 5, 8, 12, 20 and 33 degrees, the Swift reader reads
all ten at 7 of 7.

- **Payloads.** Given exact rasters with a half-module white margin, the Swift sampler reads every
  37th number from 1 to 9962 (270 numbers per shape) on `4 × 6`, `6 × 4`, `3 × 7`,
  `5 × 5` and `4 × 5`. Other payloads and shapes are not measured.
- **Pixel-aligned pictures.** Some codes that read at 3 to 20 degrees are refused at exactly 0. A
  hand-held camera does not stay there.
- **Two-row codes** (`2 × W`) are refused by the Swift reader at some quarter turns.

- **A crop that cuts into the frame can give a wrong payload.** On synthetic crops 0.1 to 0.25 modules too
  tight the Swift sampler returned a wrong payload for up to 11 of 336 codes, mostly on `2 × 9`, where the
  checksum has two bits. The reader aims its crop outside the frame to avoid this. Accept only the shapes
  you print, act on two frames, and prefer a longer checksum.

- **Two-row codes can be misread.** Their checksum has two bits. On 448 synthetic pictures of `2 × 9` the Swift
  reader took two for `2 × 11`; on four lab pictures (two pairs of the same two) the JavaScript reader took
  `2 × 6` for `2 × 8`. The Kotlin reader shares its method and was not run on them.
- **An all-zero payload** leaves few dark cells: 14 zero bits on `4 × 6` are refused.

Test every code you are about to print in quantity.
