import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { paletteFor } from "../palette";
import type { FilePlayback } from "../playback/reducer";
import type { CityFile, CityMap, Touch } from "../types";
import {
  attentionColumns,
  attentionHeight,
  columnHeight,
  diffColumns,
  diffHeight,
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
    const columns = diffColumns(
      map(),
      churn({ "big.ts": { additions: 10, deletions: 0 } }),
      palette,
    );
    expect(columns.map((column) => column.fileId)).toEqual([0]);
  });

  it("stacks additions under deletions", () => {
    const [column] = diffColumns(
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

  it("orders height by churn, compressively", () => {
    const columns = diffColumns(
      map(),
      churn({
        "big.ts": { additions: 500, deletions: 0 },
        "small.ts": { additions: 50, deletions: 0 },
      }),
      palette,
    );
    const [big, small] = columns;
    expect(columnHeight(big)).toBeGreaterThan(columnHeight(small));
    // ten times the churn, nowhere near ten times the height — that gap is the
    // whole reason a busy file and a quiet one can share a stage
    expect(columnHeight(big) / columnHeight(small)).toBeLessThan(3);
  });

  it("keeps a one-line deletion visible against five hundred additions", () => {
    const [column] = diffColumns(
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
    expect(columnHeight(column)).toBeCloseTo(diffHeight(501), 5);
  });

  it("does not flatten a small column's split to fifty-fifty", () => {
    // 30 : 5 against a range whose busiest file churned 1000 — small enough
    // that both halves would otherwise be pinned to the segment minimum
    const columns = diffColumns(
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
    const [column] = diffColumns(
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
    const added = diffColumns(map(), churn({ "big.ts": { additions: 7, deletions: 0 } }), palette);
    const removed = diffColumns(
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
    const columns = diffColumns(
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
    const columns = diffColumns(
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

  // Height is absolute: the same file is the same height whatever it sits
  // next to, in any step of any range in any repository. A relative scale
  // would make a quiet commit look busy simply for being on its own.
  it("gives a file the same height whatever else changed alongside it", () => {
    const alone = diffColumns(
      map(),
      churn({ "small.ts": { additions: 30, deletions: 0 } }),
      palette,
    );
    const beside = diffColumns(
      map(),
      churn({
        "small.ts": { additions: 30, deletions: 0 },
        "big.ts": { additions: 4000, deletions: 0 },
      }),
      palette,
    );
    const find = (columns: ReturnType<typeof diffColumns>) =>
      columnHeight(columns.find((column) => column.fileId === 1));
    expect(find(alone)).toBeCloseTo(find(beside), 6);
  });

  // The reason this is a log curve. Churn is heavily skewed — over this repo's
  // last thirty commits the median changed file is 26 lines against a busiest
  // of 478 — so a linear scale put two thirds of the city on the floor.
  it("keeps a typical file well clear of the floor, and still grows past it", () => {
    const height = (lines: number) =>
      columnHeight(
        diffColumns(map(), churn({ "big.ts": { additions: lines, deletions: 0 } }), palette)[0],
      );

    expect(height(1)).toBeLessThan(2);
    expect(height(26)).toBeGreaterThan(5);
    expect(height(478)).toBeGreaterThan(height(26) * 2);
    // each multiplication of churn adds a step rather than multiplying height,
    // which is what keeps the tallest column on stage
    expect(height(20_000)).toBeLessThan(height(2_000) * 2);
    expect(height(20_000)).toBeGreaterThan(height(2_000));
  });
});
