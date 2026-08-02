/**
 * The terrain's height policy, as data.
 *
 * `CityScene` used to branch on which prop was present — `playback` for
 * attention, `locHeights` for file size — and every new way of driving the
 * terrain added another optional prop, another representable-but-invalid
 * combination, and another undocumented precedence rule. All of those modes
 * differ in exactly one thing: how tall each file's column is and what colour.
 * Meshes, picking, labels, camera, trail and selection are identical across
 * every one of them.
 *
 * So the scene takes `columns` and nothing else, and each mode is a plain
 * function from its own data to a `Column[]`. That makes the height maths
 * testable without mounting WebGL, and it is why stacking needed no second
 * mesh: a diff column is one file with two segments.
 *
 * Deliberately diverges from mindwalk, whose `CityScene` carries the two-mode
 * branch (`.repos/mindwalk/web/src/scene/CityScene.tsx:28, 45, 62, 88, 524`).
 * See AGENTS.md § This fork: none of `apps/web/src/mindwalk/` exists upstream
 * of T3, so the conflict surface that matters is zero.
 *
 * @module columns
 */
import * as THREE from "three";

import type { ScenePalette } from "../palette";
import type { FilePlayback } from "../playback/reducer";
import type { CityFile, CityMap, Touch } from "../types";

/** One slab of a stacked column. Segments are listed bottom first. */
export interface ColumnSegment {
  readonly height: number;
  readonly color: THREE.Color;
}

/** One file's terrain column. A file with nothing to say gets no column. */
export interface Column {
  readonly fileId: number;
  readonly segments: readonly ColumnSegment[];
}

/**
 * The most segments any mode stacks on one file.
 *
 * Two things depend on it: the terrain mesh reserves this many instances per
 * file, and the growth animation keys its in-flight heights by
 * `fileId * MAX_COLUMN_SEGMENTS + index`. A mode that wants a third slab has
 * to raise this — the alternative, growing the buffers on demand, is a second
 * allocation path to keep in step with scene construction forever.
 */
export const MAX_COLUMN_SEGMENTS = 2;

/** Ghost files are drawn hollow: their colour is pulled toward the ghost grey
 * rather than replaced, so touch and churn stay readable on a deleted file. */
const GHOST_MIX = 0.45;

function ghosted(color: THREE.Color, file: CityFile, palette: ScenePalette): THREE.Color {
  return file.ghost ? color.lerp(new THREE.Color(palette.city.ghost), GHOST_MIX) : color;
}

// ---------------------------------------------------------------- attention

/**
 * Attention terrain: the map is a flat plain (fog of war) and height is earned
 * by attention — touch depth × revisits — so mountains grow where the walker
 * lingered.
 */
export function attentionHeight(touch: Touch, visits: number): number {
  const base = touch === "edit" ? 7.2 : touch === "read" ? 4.2 : 1.6;
  return base * (1 + 0.35 * Math.log2(Math.max(visits, 1)));
}

export function attentionColumns(
  city: CityMap,
  playback: FilePlayback,
  palette: ScenePalette,
): Column[] {
  const columns: Column[] = [];
  for (const file of city.files) {
    const touch = playback.touchByFile.get(file.id);
    if (!touch) continue;
    const visits = playback.visitsByFile.get(file.id) ?? 1;
    const color = ghosted(new THREE.Color(palette.touch[touch]), file, palette);
    columns.push({
      fileId: file.id,
      segments: [{ height: attentionHeight(touch, visits), color }],
    });
  }
  return columns;
}

// --------------------------------------------------------------------- size

// Static map height: normalized lines of code, log-scaled so a few huge files
// don't flatten everything else. maxLog is log2(largest file's lines).
const LOC_MIN_H = 0.3;
const LOC_MAX_H = 16;
// gamma > 1 exaggerates the top end: small files stay low, big files spike, so
// the skyline reads as a city (towers vs shacks) instead of a uniform plateau
const LOC_HEIGHT_GAMMA = 2.2;

/** Normalized 0..1 position of a file by lines of code (log-scaled). */
export function locFraction(lines: number, maxLog: number): number {
  if (maxLog <= 0) return 0;
  return Math.min(1, Math.log2(Math.max(lines, 1)) / maxLog);
}

export function locHeight(t: number): number {
  return LOC_MIN_H + Math.pow(t, LOC_HEIGHT_GAMMA) * (LOC_MAX_H - LOC_MIN_H);
}

// LOC tier ramp: small files stay grey, then warm up through orange and purple
// to red for the largest files. Stops are interpolated so the terrain reads as
// a continuous gradient rather than hard bands. Positions are fixed; the four
// colors come from the palette (grey stop always matches `unvisited`).
const LOC_RAMP_STOPS = [0.0, 0.35, 0.7, 1.0] as const;

export function locColor(t: number, palette: ScenePalette): THREE.Color {
  const ramp = LOC_RAMP_STOPS.map((at, i) => ({
    at,
    color: new THREE.Color(palette.city.locRamp[i]!),
  }));
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i]!.at) {
      const lo = ramp[i - 1]!;
      const hi = ramp[i]!;
      const span = hi.at - lo.at;
      const k = span > 0 ? (t - lo.at) / span : 0;
      return lo.color.clone().lerp(hi.color, k);
    }
  }
  return ramp[ramp.length - 1]!.color.clone();
}

/** Static map mode: with no session to drive attention, raise every column by
 * its file size instead of leaving the plain flat. */
export function sizeColumns(city: CityMap, palette: ScenePalette): Column[] {
  const maxLog = Math.log2(
    Math.max(
      1,
      city.files.reduce((m, f) => Math.max(m, f.lines), 1),
    ),
  );
  return city.files.map((file) => {
    const t = locFraction(file.lines, maxLog);
    return {
      fileId: file.id,
      segments: [{ height: locHeight(t), color: ghosted(locColor(t, palette), file, palette) }],
    };
  });
}

// --------------------------------------------------------------------- diff

/** One file's churn in a single step. Steps do not accumulate — see below. */
export interface FileChurn {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * The two numbers that set how tall a diff column stands, and the only two to
 * touch when it looks wrong:
 *
 *   height = DIFF_HEIGHT_GAIN × ln(1 + churn / DIFF_HEIGHT_KNEE)
 *
 * `GAIN` is overall scale — raise it and everything grows together. `KNEE` is
 * where the curve stops being roughly linear and starts compressing; below it
 * a few lines stay a nub, above it each multiplication of churn adds a fixed
 * amount rather than a proportional one.
 *
 * Anchors these produce, against the 120-wide world:
 *
 *   1 line      0.9  (the floor)      478      20.5
 *   26          7.5                   1,300    25.3
 *   92         12.8                   5,000    31.7
 *   232        17.1                   20,000   38.4
 *
 * Unbounded on purpose, and safe because it grows so slowly: ten times the
 * churn is a fixed step taller, not ten times taller, so no repository can
 * produce a column that leaves the stage. `CityScene` fits the camera around
 * the tallest one rather than the ground alone, so nothing crops either.
 */
const DIFF_HEIGHT_GAIN = 4.83;
const DIFF_HEIGHT_KNEE = 7;

/** How tall one file's column stands for a given number of changed lines. */
export function diffHeight(churn: number): number {
  return DIFF_HEIGHT_GAIN * Math.log1p(Math.max(churn, 0) / DIFF_HEIGHT_KNEE);
}
/**
 * The shortest a whole column is ever drawn, so a one-line change in a range
 * of thousands is still a building rather than bare ground. Several times the
 * footprint tile at its base (`TILE_H`), which would otherwise swallow it.
 */
const MIN_COLUMN_H = 0.9;
/**
 * The shortest a *segment* is drawn, which keeps one deleted line against five
 * hundred added ones from collapsing sub-pixel and reading as a pure addition.
 *
 * The smaller half buys that visibility out of the larger half rather than by
 * growing the column: a minimum applied to both segments independently makes
 * every small column read 50/50 no matter what its real split was, which
 * inverts the thing the minimum exists to protect. Taking it from the sibling
 * keeps the column's *height* honest — heights compare files, and it is only
 * within one small column that the split is approximate.
 */
const MIN_SEGMENT_H = 0.35;

/**
 * Stacked diff terrain: height is churn — additions + deletions, not the net —
 * green from the ground up and red capping it, split by proportion.
 *
 * Red on top because a tilted camera occludes column bases in a dense city but
 * never their tops.
 *
 * **Height is absolute, and log-scaled.** Both were wrong in the first cut and
 * the difference is visible the moment you open it.
 *
 * Log, because churn is heavily skewed: over this repo's last thirty commits
 * the median changed file is 26 lines against a busiest of 478, so a linear
 * scale put **two thirds of every city on the floor**. The earlier reasoning —
 * that a diff range has no long tail because it covers tens of files rather
 * than thousands — confused how many files there are with how their churn is
 * spread. It is the spread that decides.
 *
 * Absolute, because a scale taken from the range means the same file is a
 * different height depending on what it is next to. Fixed anchors let height
 * mean one thing everywhere: across steps, across ranges, across repositories.
 * A quiet commit is then genuinely flat, which is the honest picture of a
 * quiet commit.
 *
 * What height does not carry is precision at the top — 5,000 lines and 8,000
 * are about one unit apart. That is inherent to staying on screen, and the
 * hover readout gives the exact counts.
 *
 * A binary file arrives from the endpoint as `0`/`0` — it has a path and no
 * lines to count. It gets one minimum-height segment in the neutral grey
 * rather than nothing at all: a changed file that renders as bare ground is a
 * worse lie than one whose height says "unmeasurable".
 */
export function diffColumns(
  city: CityMap,
  churnByPath: ReadonlyMap<string, FileChurn>,
  palette: ScenePalette,
): Column[] {
  const added = new THREE.Color(palette.city.diffAdded);
  const removed = new THREE.Color(palette.city.diffRemoved);
  const neutral = new THREE.Color(palette.city.unvisited);

  const columns: Column[] = [];
  for (const file of city.files) {
    const churn = churnByPath.get(file.path);
    if (!churn) continue;
    const total = churn.additions + churn.deletions;
    if (total === 0) {
      columns.push({
        fileId: file.id,
        segments: [{ height: MIN_COLUMN_H, color: ghosted(neutral.clone(), file, palette) }],
      });
      continue;
    }
    const height = Math.max(diffHeight(total), MIN_COLUMN_H);
    const addColor = () => ghosted(added.clone(), file, palette);
    const removeColor = () => ghosted(removed.clone(), file, palette);
    if (churn.deletions === 0) {
      columns.push({ fileId: file.id, segments: [{ height, color: addColor() }] });
      continue;
    }
    if (churn.additions === 0) {
      columns.push({ fileId: file.id, segments: [{ height, color: removeColor() }] });
      continue;
    }
    // floor the smaller half first and let the larger one take what is left,
    // so the column's height stays what churn says it is
    const addShare = (churn.additions / total) * height;
    const removeShare = height - addShare;
    const addHeight =
      addShare <= removeShare
        ? Math.max(addShare, MIN_SEGMENT_H)
        : Math.max(height - Math.max(removeShare, MIN_SEGMENT_H), MIN_SEGMENT_H);
    columns.push({
      fileId: file.id,
      segments: [
        { height: addHeight, color: addColor() },
        { height: Math.max(height - addHeight, MIN_SEGMENT_H), color: removeColor() },
      ],
    });
  }
  return columns;
}

/** Total height of a column, which is where the trail and firefly ride. */
export function columnHeight(column: Column | undefined): number {
  if (!column) return 0;
  let total = 0;
  for (const segment of column.segments) total += segment.height;
  return total;
}
