/**
 * CitymapLayout - the squarified-treemap layout, ported near-verbatim from
 * mindwalk's `internal/citymap/builder.go` (MIT, © 2026 Ricko Yu).
 *
 * Pure and IO-free: it takes already-inspected files and lays them into the
 * 120x120 world. Keeping it separate from the filesystem walk is what makes the
 * layout testable against mindwalk's own fixtures, and what keeps the layout
 * trace-independent — the same repository always produces the same city.
 *
 * Deviations from mindwalk are deliberate omissions of *nothing*: no exclusion
 * globs, no float rounding, no aggregation. Those are measured wins but they
 * are post-port work, not part of the translation.
 *
 * @module CitymapLayout
 */
import type { Citymap, CitymapDir, CitymapFile, CitymapRect } from "@t3tools/contracts";

/** The world is a fixed 120x120 square; every rect is baked into it. */
const WORLD_SIZE = 120;
/** Gap carved out of every child rect, so buildings never touch. */
const CHILD_INSET = 0.08;
/** Rects wider or deeper than this ratio get centred and trimmed. */
const MAX_ASPECT_RATIO = 40;
/** A file counts for at least this many weight units, so tiny files stay clickable. */
const MIN_WEIGHT_UNITS = 16;
/** Bytes that count for one weight unit when a file has more bytes than lines. */
const BYTES_PER_WEIGHT_UNIT = 4096;

export const CITYMAP_VERSION = 1;
export const CITYMAP_LAYOUT_ALGORITHM = "squarified-treemap-v1";
export const CITYMAP_LAYOUT_WEIGHT = "sqrt(max(lines, bytes/4096, 16))";

/** One inspected file, before it has an id or a rect. */
export interface InspectedFile {
  readonly path: string;
  readonly dir: string;
  readonly lines: number;
  readonly bytes: number;
  readonly lang: string;
}

interface MutableCitymapFile {
  id: number;
  path: string;
  dir: string;
  lines: number;
  bytes: number;
  lang: string;
  rect: CitymapRect;
  ghost: boolean;
}

interface LayoutNode {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, LayoutNode>;
  readonly files: Array<number>;
  weight: number;
  rect: CitymapRect;
  fileCount: number;
  lines: number;
}

interface LayoutItem {
  readonly name: string;
  readonly kind: "dir" | "file";
  readonly index: number;
  readonly node: LayoutNode | null;
  readonly weight: number;
  area: number;
}

interface PlacedItem {
  readonly item: LayoutItem;
  readonly rect: CitymapRect;
}

/**
 * Language label for a path, keyed off the extension exactly as Go's
 * `filepath.Ext` sees it — a dotfile like `.gitignore` is all extension.
 */
export function langForPath(path: string): string {
  const ext = extensionOf(path).replace(/^\./, "").toLowerCase();
  switch (ext) {
    case "go":
      return "go";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "md":
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "css":
      return "css";
    case "html":
      return "html";
    case "":
      return "text";
    default:
      return ext;
  }
}

/** Go's `filepath.Ext`: the suffix from the final dot of the final path element. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot);
}

/** Go's `filepath.Dir` for a slash path, with the root's "." flattened to "". */
export function dirForPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "" : path.slice(0, separator);
}

/**
 * Lay inspected files (plus any ghost paths — files the caller knows about that
 * no longer exist on disk) into a complete citymap.
 */
export function buildCitymap(input: {
  readonly root: string;
  readonly commit: string | null;
  readonly dirty: boolean;
  readonly generatedAt: string;
  readonly files: ReadonlyArray<InspectedFile>;
  readonly ghostPaths?: ReadonlyArray<string>;
}): Citymap {
  const seen = new Set<string>();
  const cityFiles: Array<MutableCitymapFile> = [];
  for (const file of input.files) {
    seen.add(file.path);
    cityFiles.push({
      id: 0,
      path: file.path,
      dir: file.dir,
      lines: file.lines,
      bytes: file.bytes,
      lang: file.lang,
      rect: { x: 0, z: 0, w: 0, d: 0 },
      ghost: false,
    });
  }

  // Ghosts keep a deleted file's building standing so a trace that touched it
  // still has somewhere to land. Note mindwalk does not flatten a root ghost's
  // dir to "" the way it does for real files; that quirk is preserved.
  for (const path of input.ghostPaths ?? []) {
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    cityFiles.push({
      id: 0,
      path,
      dir: goDir(path),
      lines: 0,
      bytes: 0,
      lang: langForPath(path),
      rect: { x: 0, z: 0, w: 0, d: 0 },
      ghost: true,
    });
  }

  cityFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  cityFiles.forEach((file, index) => {
    file.id = index;
  });

  const rootNode = buildTree(cityFiles);
  const dirs: Array<CitymapDir> = [];
  layoutNode(rootNode, { x: 0, z: 0, w: WORLD_SIZE, d: WORLD_SIZE }, cityFiles, dirs);

  return {
    version: CITYMAP_VERSION,
    repo: {
      root: input.root,
      ...(input.commit ? { commit: input.commit } : {}),
      dirty: input.dirty,
      generatedAt: input.generatedAt,
    },
    files: cityFiles.map(
      (file): CitymapFile => ({
        id: file.id,
        path: file.path,
        dir: file.dir,
        lines: file.lines,
        bytes: file.bytes,
        ...(file.lang ? { lang: file.lang } : {}),
        rect: file.rect,
        ghost: file.ghost,
      }),
    ),
    dirs,
    layout: {
      algorithm: CITYMAP_LAYOUT_ALGORITHM,
      weight: CITYMAP_LAYOUT_WEIGHT,
    },
  };
}

/** Go's `filepath.Dir`, which yields "." rather than "" for a bare filename. */
function goDir(path: string): string {
  const separator = path.lastIndexOf("/");
  if (separator === -1) return ".";
  if (separator === 0) return "/";
  return path.slice(0, separator);
}

function buildTree(files: ReadonlyArray<MutableCitymapFile>): LayoutNode {
  const root = makeNode("", "");
  files.forEach((file, index) => {
    const parts = splitPath(file.path);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let next = current.children.get(part);
      if (!next) {
        next = makeNode(part, current.path === "" ? part : `${current.path}/${part}`);
        current.children.set(part, next);
      }
      current = next;
    }
    current.files.push(index);
  });
  computeWeight(root, files);
  return root;
}

function makeNode(name: string, path: string): LayoutNode {
  return {
    name,
    path,
    children: new Map(),
    files: [],
    weight: 0,
    rect: { x: 0, z: 0, w: 0, d: 0 },
    fileCount: 0,
    lines: 0,
  };
}

function splitPath(path: string): ReadonlyArray<string> {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length === 0 ? [path] : parts;
}

function computeWeight(node: LayoutNode, files: ReadonlyArray<MutableCitymapFile>): number {
  node.weight = 0;
  for (const index of node.files) {
    node.weight += fileWeight(files[index]!);
    node.fileCount += 1;
    node.lines += files[index]!.lines;
  }
  for (const child of sortedChildren(node)) {
    node.weight += computeWeight(child, files);
    node.fileCount += child.fileCount;
    node.lines += child.lines;
  }
  if (node.weight <= 0) {
    node.weight = 1;
  }
  return node.weight;
}

function layoutNode(
  node: LayoutNode,
  rect: CitymapRect,
  files: Array<MutableCitymapFile>,
  dirs: Array<CitymapDir>,
): void {
  node.rect = rect;
  if (node.path !== "") {
    dirs.push({
      path: node.path,
      depth: node.path.split("/").length,
      rect: node.rect,
      fileCount: node.fileCount,
      lines: node.lines,
    });
  }

  const items: Array<LayoutItem> = [];
  for (const child of sortedChildren(node)) {
    items.push({
      name: child.name,
      kind: "dir",
      index: 0,
      node: child,
      weight: child.weight,
      area: 0,
    });
  }
  for (const index of node.files) {
    items.push({
      name: files[index]!.path,
      kind: "file",
      index,
      node: null,
      weight: fileWeight(files[index]!),
      area: 0,
    });
  }
  items.sort((a, b) =>
    a.weight === b.weight ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : b.weight - a.weight,
  );

  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return;

  const scale = (rect.w * rect.d) / total;
  for (const item of items) {
    item.area = item.weight * scale;
  }

  for (const placed of squarify(rect, items)) {
    const childRect = capAspect(inset(placed.rect, CHILD_INSET), MAX_ASPECT_RATIO);
    if (placed.item.kind === "dir") {
      layoutNode(placed.item.node!, childRect, files, dirs);
    } else {
      files[placed.item.index]!.rect = childRect;
    }
  }
}

function sortedChildren(node: LayoutNode): ReadonlyArray<LayoutNode> {
  return [...node.children.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => node.children.get(name)!);
}

function capAspect(rect: CitymapRect, maxRatio: number): CitymapRect {
  if (rect.w <= 0 || rect.d <= 0 || maxRatio <= 1) return rect;
  if (rect.w / rect.d > maxRatio) {
    const width = rect.d * maxRatio;
    return { x: rect.x + (rect.w - width) / 2, z: rect.z, w: width, d: rect.d };
  }
  if (rect.d / rect.w > maxRatio) {
    const depth = rect.w * maxRatio;
    return { x: rect.x, z: rect.z + (rect.d - depth) / 2, w: rect.w, d: depth };
  }
  return rect;
}

function inset(rect: CitymapRect, pad: number): CitymapRect {
  const insetX = rect.w > pad * 2;
  const insetZ = rect.d > pad * 2;
  return {
    x: insetX ? rect.x + pad : rect.x,
    z: insetZ ? rect.z + pad : rect.z,
    w: insetX ? rect.w - pad * 2 : rect.w,
    d: insetZ ? rect.d - pad * 2 : rect.d,
  };
}

function fileWeight(file: Pick<MutableCitymapFile, "lines" | "bytes">): number {
  let units = file.lines;
  const byteUnits = file.bytes / BYTES_PER_WEIGHT_UNIT;
  if (byteUnits > units) units = byteUnits;
  if (units < MIN_WEIGHT_UNITS) units = MIN_WEIGHT_UNITS;
  return Math.sqrt(units);
}

function squarify(rect: CitymapRect, items: ReadonlyArray<LayoutItem>): ReadonlyArray<PlacedItem> {
  let remaining = rect;
  const placed: Array<PlacedItem> = [];
  let row: Array<LayoutItem> = [];
  items.forEach((item, index) => {
    if (item.area <= 0) return;
    const side = Math.min(remaining.w, remaining.d);
    if (
      row.length < 2 ||
      index === items.length - 1 ||
      worstAspect([...row, item], side) <= worstAspect(row, side)
    ) {
      row.push(item);
      return;
    }
    const laid = layoutRow(remaining, row);
    placed.push(...laid.placed);
    remaining = laid.remaining;
    row = [item];
  });
  if (row.length > 0) {
    placed.push(...layoutRow(remaining, row).placed);
  }
  return placed;
}

function worstAspect(row: ReadonlyArray<LayoutItem>, side: number): number {
  if (row.length === 0 || side <= 0) return Infinity;
  let sum = 0;
  let minArea = Infinity;
  let maxArea = 0;
  for (const item of row) {
    sum += item.area;
    minArea = Math.min(minArea, item.area);
    maxArea = Math.max(maxArea, item.area);
  }
  if (sum <= 0 || minArea <= 0) return Infinity;
  const side2 = side * side;
  const sum2 = sum * sum;
  return Math.max((side2 * maxArea) / sum2, sum2 / (side2 * minArea));
}

function layoutRow(
  rect: CitymapRect,
  row: ReadonlyArray<LayoutItem>,
): { readonly placed: ReadonlyArray<PlacedItem>; readonly remaining: CitymapRect } {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (sum <= 0) return { placed: [], remaining: rect };

  const placed: Array<PlacedItem> = [];
  let remaining: CitymapRect;
  if (rect.w >= rect.d) {
    const rowDepth = sum / rect.w;
    let x = rect.x;
    row.forEach((item, index) => {
      const width = index === row.length - 1 ? rect.x + rect.w - x : item.area / rowDepth;
      placed.push({ item, rect: { x, z: rect.z, w: width, d: rowDepth } });
      x += width;
    });
    remaining = { x: rect.x, z: rect.z + rowDepth, w: rect.w, d: rect.d - rowDepth };
  } else {
    const rowWidth = sum / rect.d;
    let z = rect.z;
    row.forEach((item, index) => {
      const depth = index === row.length - 1 ? rect.z + rect.d - z : item.area / rowWidth;
      placed.push({ item, rect: { x: rect.x, z, w: rowWidth, d: depth } });
      z += depth;
    });
    remaining = { x: rect.x + rowWidth, z: rect.z, w: rect.w - rowWidth, d: rect.d };
  }

  return {
    placed,
    remaining: {
      ...remaining,
      w: Math.max(remaining.w, 0),
      d: Math.max(remaining.d, 0),
    },
  };
}
