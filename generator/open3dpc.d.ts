// Types for open3dpc.js: Open3DPC v2 encoding, SVG, PNG and STL. The module itself is plain JavaScript.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

/** Payload bits as a string of `0` and `1`, most significant first. */
export type Bits = string;

/** A shape: `h` rows by `w` columns of data cells, inside the frame. */
export interface Geometry {
  h: number;
  w: number;
}

export type CellKind = 'orientation' | 'payload' | 'terminator' | 'padding' | 'crc';

/** One cell of the grid. `bit` is null only for the orientation cell. */
export interface Cell {
  kind: CellKind;
  bit: '0' | '1' | null;
}

/** A built code: what `encode` returns and the drawing functions take. */
export interface Code {
  h: number;
  w: number;
  payload: Bits;
  padding: Bits;
  dataRegion: Bits;
  crc: Bits;
  encodedBits: Bits;
  cells: Cell[][];
  /** The grid as text, `O` for the orientation cell, as the test vectors write it. */
  rows: string[];
}

export interface PhysicalSize {
  /** Width and height of the code with its frame, in millimetres. */
  width: number;
  height: number;
  /** The same with the half-module quiet zone around it. */
  quietWidth: number;
  quietHeight: number;
}

export const DEFAULT_MODULE_MM: number;
export const DEFAULT_MATERIAL_HEIGHT_MM: number;
export const MAX_CRC_WIDTH: number;
export const COMPACT_MAX: number;
/** The CRC polynomial for each checksum width, 1 to 10. */
export const FULL_POLYNOMIALS: Readonly<Record<number, number>>;
/** Fill colours of the debug drawing, `[for 0, for 1]` per cell kind. */
export const DEBUG_COLOURS: Readonly<Record<'payload' | 'terminator' | 'padding' | 'crc', readonly [string, string]>>;

/** Checksum width of a code with `h` rows: `min(h, 10)`. */
export function crcWidth(h: number): number;
export function dataRegionLength(h: number, w: number): number;
/** How many payload bits `h` × `w` holds. */
export function payloadCapacity(h: number, w: number): number;
export function isValidGeometry(h: number, w: number): boolean;
export function physicalSize(h: number, w: number, module?: number): PhysicalSize;

/** Shapes that hold `bits` payload bits, up to `maximumCapacity`. */
export function candidates(bits: number, options?: {
  minimumCapacity?: number;
  maximumCapacity?: number;
  maximumRows?: number | null;
  maximumColumns?: number | null;
}): Geometry[];

/** An unsigned decimal integer as bits; `width` pads with leading zeroes and throws if the number needs more. */
export function bitsFromInteger(decimal: string | number | bigint, width?: number): Bits;
export function crc(dataRegion: Bits, h: number): Bits;
/** Everything before the last `1` of a data region. */
export function payloadFromDataRegion(dataRegion: Bits): Bits;

/** Builds a code of `h` rows and `w` columns. Throws if the shape is not valid or too small for the payload. */
export function encode(payload: Bits, h: number, w: number): Code;

export type DecodeResult =
  | { h: number; w: number; payload: Bits; error?: undefined }
  | { error: 'invalid_orientation' | 'invalid_geometry' | 'crc_mismatch' | 'empty_data_region' };

/** Decodes a sampled matrix, rows of `0`, `1` and one `O`, in any of four rotations. */
export function decode(observed: string[]): DecodeResult;

/** The code on its half-module grid, frame included: 1 is dark. */
export function darkGrid(code: Code): (0 | 1)[][];
/** Connected dark shapes of a grid, each a list of `[row, column]`. */
export function components(grid: ArrayLike<ArrayLike<number>>): [number, number][][];

/** Exact SVG in millimetres. */
export function svg(code: Code, options?: { module?: number; debug?: boolean; quietZone?: boolean }): string;

/** A grey picture of the code: one byte a pixel, 17 dark and 255 light. */
export function raster(code: Code, options?: { scale?: number; quietZone?: boolean }): {
  width: number;
  height: number;
  pixels: Uint8Array;
};

/** Binary STL of the dark material, from Z 0 to `materialHeight`. */
export function stl(code: Code, options?: { module?: number; materialHeight?: number }): Uint8Array;

/** Binary STL of the light body: quiet zone, gaps and zero cells over a plate `plate` thick. Same origin as `stl`. */
export function backingStl(code: Code, options?: { module?: number; materialHeight?: number; plate?: number }): Uint8Array;
