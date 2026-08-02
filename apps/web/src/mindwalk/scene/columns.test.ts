import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { paletteFor } from "../palette";
import type { ScenePalette } from "../palette";
import type { FilePlayback } from "../playback/reducer";
import type { CityFile, CityMap, Touch } from "../types";
import {
  attentionColumns,
  attentionHeight,
  columnHeight,
  diffColumns,
  locHeight,
  locFraction,
  MAX_COLUMN_SEGMENTS,
  sizeColumns,
  type FileChurn,
} from "./columns";

const palette = paletteFor("dark").scene;

function city(...files: Array<Partial<CityFile> & { path: string }>): CityMap {
  return {
    version: 1,
    repo: { root: "/repo", dirty: false, generatedAt: "2026-01-01T00:00:00Z" },
    files: files.map((file, id) => ({
      id,
      dir: "",
      lines: 10,
      bytes: 100,
      rect: { x: 0, z: 0, w: 1, d: 1 },
      ghost: false,
      ...file,
    })),
    dirs: [],
    layout: { algorithm: "squarified", weight: "lines" },
  };
}

function walk(touches: Array<{ id: number; touch: Touch; visits?: number }>): FilePlayback {
  return {
    touchByFile: new Map(touches.map((entry) => [entry.id, entry.touch])),
    touchByPath: new Map(),
    visitsByFile: new Map(touches.map((entry) => [entry.id, entry.visits ?? 1])),
    historyByPath: new Map(),
    recentTargets: [],
  };
}

const churn = (entries: Record<string, FileChurn>): ReadonlyMap<string, FileChurn> =>
  new Map(Object.entries(entries));

/**
 * Scale to the frame's own busiest file. That is what these cases were written
 * against and what they are about — shape, split, colour. The scale being a
 * property of the whole range rather than the frame is its own case, last.
 */
const scaledToFrame = (
  map: CityMap,
  entries: ReadonlyMap<string, FileChurn>,
  scenePalette: ScenePalette,
) => {
  let peak = 0;
  for (const entry of entries.values()) peak = Math.max(peak, entry.additions + entry.deletions);
  return diffColumns(map, entries, peak, scenePalette);
};

describe("attention columns", () => {
  it("raises a column only for files the walk touched", () => {
    const map = city({ path: "a.ts" }, { path: "b.ts" });
    const columns = attentionColumns(map, walk([{ id: 0, touch: "edit" }]), palette);
    expect(columns.map((column) => column.fileId)).toEqual([0]);
    expect(columns[0]!.segments).toHaveLength(1);
  });

  it("orders height by touch depth and grows it with revisits", () => {
    expect(attentionHeight("edit", 1)).toBeGreaterThan(attentionHeight("read", 1));
    expect(attentionHeight("read", 1)).toBeGreaterThan(attentionHeight("hit", 1));
    expect(attentionHeight("edit", 8)).toBeGreaterThan(attentionHeight("edit", 1));
  });

  it("pulls a ghost file's colour toward the ghost grey", () => {
    const map = city({ path: "gone.ts", ghost: true });
    const [solid] = attentionColumns(
      city({ path: "here.ts" }),
      walk([{ id: 0, touch: "edit" }]),
      palette,
    );
    const [ghost] = attentionColumns(map, walk([{ id: 0, touch: "edit" }]), palette);
    expect(ghost!.segments[0]!.color.getHexString()).not.toBe(
      solid!.segments[0]!.color.getHexString(),
    );
  });
});

describe("size columns", () => {
  it("gives every file exactly one column", () => {
    const map = city({ path: "a.ts", lines: 10 }, { path: "b.ts", lines: 2000 });
    const columns = sizeColumns(map, palette);
    expect(columns).toHaveLength(2);
    expect(columns.every((column) => column.segments.length === 1)).toBe(true);
  });

  it("is monotonic in lines", () => {
    const maxLog = Math.log2(2000);
    expect(locHeight(locFraction(2000, maxLog))).toBeGreaterThan(
      locHeight(locFraction(10, maxLog)),
    );
  });
});

describe("diff columns", () => {
  const map = () =>
    city({ path: "big.ts" }, { path: "small.ts" }, { path: "binary.png" }, { path: "quiet.ts" });

  it("skips files the range never changed", () => {
    const columns = scaledToFrame(
      map(),
      churn({ "big.ts": { additions: 10, deletions: 0 } }),
      palette,
    );
    expect(columns.map((column) => column.fileId)).toEqual([0]);
  });

  it("stacks additions under deletions", () => {
    const [column] = scaledToFrame(
      map(),
      churn({ "big.ts": { additions: 300, deletions: 100 } }),
      palette,
    );
    expect(column!.segments).toHaveLength(2);
    const [added, removed] = column!.segments;
    expect(added!.color.getHexString()).toBe(
      new THREE.Color(palette.city.diffAdded).getHexString(),
    );
    expect(removed!.color.getHexString()).toBe(
      new THREE.Color(palette.city.diffRemoved).getHexString(),
    );
    // 300 : 100 — the split is the thing the eye reads, so it stays exact
    expect(added!.height / removed!.height).toBeCloseTo(3, 5);
  });

  it("scales total height with churn across files", () => {
    const columns = scaledToFrame(
      map(),
      churn({
        "big.ts": { additions: 500, deletions: 0 },
        "small.ts": { additions: 50, deletions: 0 },
      }),
      palette,
    );
    const [big, small] = columns;
    expect(columnHeight(big)).toBeGreaterThan(columnHeight(small));
    expect(columnHeight(big) / columnHeight(small)).toBeCloseTo(10, 5);
  });

  it("keeps a one-line deletion visible against five hundred additions", () => {
    const [column] = scaledToFrame(
      map(),
      churn({ "big.ts": { additions: 500, deletions: 1 } }),
      palette,
    );
    const removed = column!.segments[1]!;
    // strict proportion would put this at 16/501 of the column — sub-pixel, and
    // indistinguishable from a pure addition
    expect(removed.height).toBeGreaterThan(0.3);
    // and it is bought out of the additions rather than by growing the column,
    // so height still compares this file honestly against the others
    expect(columnHeight(column)).toBeCloseTo(16, 5);
  });

  it("does not flatten a small column's split to fifty-fifty", () => {
    // 30 : 5 against a range whose busiest file churned 1000 — small enough
    // that both halves would otherwise be pinned to the segment minimum
    const columns = scaledToFrame(
      map(),
      churn({
        "small.ts": { additions: 30, deletions: 5 },
        "big.ts": { additions: 1000, deletions: 0 },
      }),
      palette,
    );
    const column = columns.find((entry) => entry.fileId === 1);
    const [added, removed] = column!.segments;
    expect(added!.height).toBeGreaterThan(removed!.height);
  });

  it("draws a deleted file as a deletions-only column, ghosted", () => {
    const map = city({ path: "gone.ts", ghost: true }, { path: "here.ts" });
    const [column] = scaledToFrame(
      map,
      churn({ "gone.ts": { additions: 0, deletions: 42 } }),
      palette,
    );
    expect(column!.segments).toHaveLength(1);
    const solid = new THREE.Color(palette.city.diffRemoved);
    const drawn = column!.segments[0]!.color;
    expect(drawn.getHexString()).not.toBe(solid.getHexString());
    // still recognisably the removal colour, just pulled toward the ghost grey
    expect(drawn.r).toBeGreaterThan(drawn.g);
  });

  it("emits one segment when only one side changed", () => {
    const added = scaledToFrame(
      map(),
      churn({ "big.ts": { additions: 7, deletions: 0 } }),
      palette,
    );
    const removed = scaledToFrame(
      map(),
      churn({ "big.ts": { additions: 0, deletions: 7 } }),
      palette,
    );
    expect(added[0]!.segments).toHaveLength(1);
    expect(removed[0]!.segments).toHaveLength(1);
    expect(added[0]!.segments[0]!.color.getHexString()).not.toBe(
      removed[0]!.segments[0]!.color.getHexString(),
    );
  });

  it("gives a binary file a neutral stub rather than nothing or a phantom height", () => {
    const columns = scaledToFrame(
      map(),
      churn({
        "big.ts": { additions: 400, deletions: 0 },
        "binary.png": { additions: 0, deletions: 0 },
      }),
      palette,
    );
    const binary = columns.find((column) => column.fileId === 2);
    expect(binary!.segments).toHaveLength(1);
    expect(binary!.segments[0]!.color.getHexString()).toBe(
      new THREE.Color(palette.city.unvisited).getHexString(),
    );
    expect(columnHeight(binary)).toBeLessThan(columnHeight(columns[0]));
    expect(columnHeight(binary)).toBeGreaterThan(0);
  });

  it("never stacks deeper than the terrain mesh reserves per file", () => {
    const columns = scaledToFrame(
      map(),
      churn({
        "big.ts": { additions: 1, deletions: 1 },
        "small.ts": { additions: 0, deletions: 0 },
      }),
      palette,
    );
    for (const column of columns) {
      expect(column.segments.length).toBeLessThanOrEqual(MAX_COLUMN_SEGMENTS);
    }
  });

  // Each step is one commit, so the scale has to come from the whole range.
  // Scaled to the frame, a quiet commit would be stretched to full height and
  // every step of the scrub would look equally busy.
  it("keeps a quiet step short against a busy one elsewhere in the range", () => {
    const quiet = churn({ "small.ts": { additions: 4, deletions: 0 } });
    const rangePeak = 400;

    const [scaledToRange] = diffColumns(map(), quiet, rangePeak, palette);
    const [stretched] = scaledToFrame(map(), quiet, palette);

    expect(columnHeight(scaledToRange)).toBeLessThan(columnHeight(stretched));
    // and a busy step in the same range still reaches the top
    const [busy] = diffColumns(
      map(),
      churn({ "big.ts": { additions: rangePeak, deletions: 0 } }),
      rangePeak,
      palette,
    );
    expect(columnHeight(busy)).toBeGreaterThan(columnHeight(scaledToRange) * 10);
  });
});
