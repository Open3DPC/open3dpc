// Types for open3dpc-reader.js: the Open3DPC v2 reader for the browser and Node. The module itself is plain JavaScript.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

export interface Point {
  x: number;
  y: number;
}

/** A rectangle in frame pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where a candidate stopped, or `validated`. */
export type Stage = 'frame' | 'sampling' | 'geometry' | 'ambiguousCell' | 'orientation' | 'crc' | 'emptyDataRegion' | 'validated';

/** One image: 8-bit luma, top row first, and RGBA when there is colour. */
export class Frame {
  constructor(luma: Uint8Array | Uint8ClampedArray, width: number, height: number, rgba?: Uint8Array | Uint8ClampedArray | null);
  readonly luma: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray | null;
  /** The whole frame as a rectangle. */
  readonly bounds: Rect;
  /** From canvas `ImageData`, or anything with `data` (RGBA), `width` and `height`. */
  static fromImageData(image: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }): Frame;
}

/** RGBA, top-down: a picture that is already one code, upright or turned. `chromatic` reads hue instead of brightness. */
export class Raster {
  constructor(bytes: Uint8Array | Uint8ClampedArray, width: number, height: number, chromatic?: boolean);
  readonly bytes: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly chromatic: boolean;
}

/** A code found in a frame, valid by its checksum. */
export interface Reading {
  /** The payload as `0` and `1`. */
  bits: string;
  /** The payload as a number; null for an empty payload. */
  value: bigint | null;
  rows: number;
  columns: number;
  /** The outside of the code's frame, in image pixels. */
  corners: Point[];
  /** The same code keeps its track from frame to frame. */
  trackId: number;
}

export interface ReaderOptions {
  /** Payload lengths this session accepts, in bits. Default: any. */
  payloadLengths?: Iterable<number> | null;
  /** Shapes this session accepts, as `[rows, columns]`. Default: any. */
  geometries?: ReadonlyArray<readonly [number, number]> | null;
}

/** Everything that looked like a code in a frame, with the stage it reached. */
export interface Observation {
  stage: Stage;
  corners: Point[];
  detail?: string;
  bits?: string;
  rows?: number;
  columns?: number;
  trackId?: number;
}

/**
 * Finds Open3DPC codes in camera frames and images. Use one reader per camera: it follows codes
 * between frames and keeps its buffers.
 */
export class Open3DPCReader {
  constructor(options?: ReaderOptions);
  /** The codes in a frame. Pass the viewfinder as `roi`: it bounds the work. */
  read(frame: Frame, roi?: Rect): Reading[];
  /** Everything that looked like a code, with the stage it reached. */
  analyze(frame: Frame, roi?: Rect): Observation[];
}

/**
 * Turns per-frame readings into one confirmed code: the same payload on the same track in two frames
 * close together. For a camera; a single photo needs only the reader.
 */
export class Open3DPCStabilizer {
  constructor(options?: { consistencyMs?: number; retentionMs?: number });
  /** Feed every frame's readings, empty ones too, with a monotonic clock. Returns the confirmed code while it is in view. */
  observe(readings: Reading[], nowMs: number): Reading | null;
  reset(): void;
}

/** The payload of a sampled matrix, rows of `0`, `1` and one `O`, in any of four rotations. */
export function validate(matrix: string[]):
  | { stage: 'validated'; bits: string; rows: number; columns: number }
  | { stage: Exclude<Stage, 'validated'> };

/** The verdict on one picture that is already the code and nothing else. */
export function analyzeRaster(raster: Raster): { stage: Stage; bits?: string; rows?: number; columns?: number; detail?: string };
