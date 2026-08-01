/**
 * Citymap - the deterministic spatial layout of a repository.
 *
 * A port of mindwalk's `internal/model` citymap contract (MIT, © 2026 Ricko Yu).
 * The wire shape is kept byte-identical to mindwalk's JSON so the ported scene
 * code reads it unchanged.
 *
 * The layout is trace-independent by design: it depends only on the repository,
 * so a file sits in the same place every session and spatial memory forms.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** A baked axis-aligned rect in the 120x120 citymap world, on the XZ plane. */
export const CitymapRect = Schema.Struct({
  x: Schema.Number,
  z: Schema.Number,
  w: Schema.Number,
  d: Schema.Number,
});
export type CitymapRect = typeof CitymapRect.Type;

/**
 * One file's building. `ghost` marks a file the layout knows about but that no
 * longer exists on disk, so it carries no lines, bytes, or meaningful size.
 */
export const CitymapFile = Schema.Struct({
  id: NonNegativeInt,
  path: Schema.String,
  dir: Schema.String,
  lines: NonNegativeInt,
  bytes: NonNegativeInt,
  lang: Schema.optionalKey(Schema.String),
  rect: CitymapRect,
  ghost: Schema.Boolean,
});
export type CitymapFile = typeof CitymapFile.Type;

/** One directory's plate, drawn under the files it contains. */
export const CitymapDir = Schema.Struct({
  path: Schema.String,
  depth: NonNegativeInt,
  rect: CitymapRect,
  fileCount: NonNegativeInt,
  lines: NonNegativeInt,
});
export type CitymapDir = typeof CitymapDir.Type;

export const CitymapRepoMeta = Schema.Struct({
  root: Schema.String,
  commit: Schema.optionalKey(Schema.String),
  dirty: Schema.Boolean,
  generatedAt: Schema.String,
});
export type CitymapRepoMeta = typeof CitymapRepoMeta.Type;

export const CitymapLayoutMeta = Schema.Struct({
  algorithm: Schema.String,
  weight: Schema.String,
});
export type CitymapLayoutMeta = typeof CitymapLayoutMeta.Type;

export const Citymap = Schema.Struct({
  version: NonNegativeInt,
  repo: CitymapRepoMeta,
  files: Schema.Array(CitymapFile),
  dirs: Schema.Array(CitymapDir),
  layout: CitymapLayoutMeta,
});
export type Citymap = typeof Citymap.Type;
