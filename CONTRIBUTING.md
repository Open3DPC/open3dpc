# Contributing

Thank you for looking. The most useful things right now:

- **Measurements.** Prints, printers, nozzles, filaments, phones, distances, light. What read and what
  did not, with photographs. Nothing on this is published yet ([what has not been
  measured](docs/concept.md#what-has-not-been-measured)).
- **Reader failures.** A photo or a frame of a code that does not read, with its payload and shape.
- **Other platforms.** A reader or a generator in another language that passes the
  [vectors](spec/vectors/v2.json).

## Ground rules

- **The specification comes first.** `spec/v2.md` and `spec/vectors/v2.json` are the source of truth.
  A change to the physical format is a new version of the format; open an issue before writing code.
- **The readers agree.** The Swift and Kotlin samplers are two copies of one algorithm, gate by gate.
  Change both, or say in the pull request why not.
- **A checksum never helps registration.** No cell is moved and no lattice preferred because the
  checksum then passes.
- **A wrong payload is worse than none.** Tests may allow a refusal, never a wrong read.
- **Claims need evidence.** Do not write that something prints, reads or lasts unless a test, a
  measurement or the specification says so.

## Running the tests

| Part | Command |
|---|---|
| Generator | `cd generator && npm test` (Node 20 or later, no packages) |
| Swift | `swift test` (macOS) |
| Kotlin | `cd kotlin && ./gradlew :open3dpc:test` (JDK 17 or 21) |

The page: `cd generator && python3 -m http.server`, then open the address it prints.
The pictures the readers are tested on come from the generator: `node generator/test/fixtures.js`
rewrites `spec/fixtures`, `node docs/img/make.mjs` the drawings.

## Licence of contributions

By contributing you agree that your code is licensed under [Apache 2.0](LICENSE) and your text and
figures under [CC BY 4.0](LICENSE-docs).
