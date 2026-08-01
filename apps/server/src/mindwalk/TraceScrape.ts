/**
 * TraceScrape - recovering file paths and intent from shell command text.
 *
 * A near-verbatim port of the string half of mindwalk's
 * `internal/adapter/adapter.go` (MIT, © 2026 Ricko Yu). Ported rather than
 * reinvented for the same reason `scene/` was copied: a subtly different regex
 * or trim order renders *almost* right, and the difference costs days to find.
 *
 * This is load-bearing, not a nicety. Measured across this environment's real
 * threads, `Bash` is 66% of every tool call and `Grep`/`Glob` never appear at
 * all — so without scraping, `search` would be ~0, the "seen" touch level would
 * never light, and the histogram would be one undifferentiated `exec` bar.
 *
 * Everything here is pure and synchronous except `repoPathExists`, which is
 * injected as a predicate so callers choose how (and whether) to hit the disk.
 *
 * @module TraceScrape
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** One `path:line` hit scraped out of command output. */
export interface PathHit {
  readonly path: string;
  readonly lines: ReadonlyArray<readonly [number, number]>;
}

/** A path the agent touched outside the repository root. */
export interface OutsideTouch {
  readonly scope: "home" | "tmp" | "other";
  readonly path: string;
}

/**
 * Resolves a scraped or typed path against the session root. Returns the
 * repo-relative path, an outside-the-repo touch, or nothing when the string is
 * not a usable path at all.
 */
export type NormalizedPath =
  | { readonly kind: "inside"; readonly path: string }
  | { readonly kind: "outside"; readonly outside: OutsideTouch }
  | { readonly kind: "none" };

const NONE: NormalizedPath = { kind: "none" };

/**
 * mindwalk's `normalizePath`. `base` is a command's own working directory when
 * one is known, used only for relative paths; `cwd` is the session root.
 *
 * Pure string math — it never touches the disk, which is what lets the whole
 * projection degrade gracefully when a worktree has been removed by hand.
 */
export function normalizePath(cwd: string, base: string, rawPath: string): NormalizedPath {
  // Quotes first, then space — Go's `TrimSpace(Trim(path, "\"'"))`. The order
  // is load-bearing: ` "a.go" ` keeps its quotes, `"  a.go  "` does not.
  const path = trimQuotes(rawPath).trim();
  if (path === "" || path.includes("\n")) return NONE;
  if (path.startsWith("http://") || path.startsWith("https://")) return NONE;

  if (!NodePath.isAbsolute(path)) {
    const clean = NodePath.normalize(path).replace(/\/+$/, "") || ".";
    if (clean === "." || clean.startsWith("..")) return NONE;
    if (base !== "" && NodePath.isAbsolute(base)) {
      const absolute = NodePath.resolve(base, clean);
      const inside = relativeInside(cwd, absolute);
      if (inside !== null) return { kind: "inside", path: inside };
      return { kind: "outside", outside: { scope: outsideScope(absolute), path: absolute } };
    }
    return { kind: "inside", path: toSlash(clean) };
  }

  const absolute = NodePath.normalize(path);
  const inside = relativeInside(cwd, absolute);
  if (inside !== null) return { kind: "inside", path: inside };
  return { kind: "outside", outside: { scope: outsideScope(absolute), path: absolute } };
}

function relativeInside(cwd: string, absolute: string): string | null {
  if (cwd === "") return null;
  const relative = NodePath.relative(NodePath.normalize(cwd), absolute);
  if (relative === "" || relative === "." || relative.startsWith("..")) return null;
  return toSlash(relative);
}

/**
 * Where an outside touch landed, so the HUD can say "home" or "tmp" without
 * leaking the path itself.
 */
function outsideScope(path: string): OutsideTouch["scope"] {
  const home = process.env.HOME ?? "";
  if (home !== "") {
    const relative = NodePath.relative(home, path);
    if (!relative.startsWith("..")) return "home";
  }
  if (path.startsWith(NodeOS.tmpdir()) || path.startsWith("/tmp")) return "tmp";
  return "other";
}

function toSlash(path: string): string {
  return NodePath.sep === "/" ? path : path.split(NodePath.sep).join("/");
}

function trimQuotes(value: string): string {
  return trimChars(value, "\"'");
}

/** Go's `strings.Trim`: strip any leading/trailing character in the cutset. */
function trimChars(value: string, cutset: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && cutset.includes(value[start]!)) start += 1;
  while (end > start && cutset.includes(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

const PATH_LINE_RE =
  /(?:^|[\s"'([])([A-Za-z0-9_./@+-]*[A-Za-z0-9_/@+-]\.[A-Za-z0-9][A-Za-z0-9._-]*):([0-9]+)/g;
const PATH_ONLY_RE =
  /(?:^|[\s"'([])([./~A-Za-z0-9_@+-]*[/][A-Za-z0-9_./~@+-]*\.[A-Za-z0-9][A-Za-z0-9._-]*)(?:$|[\s"',)\]:;])/g;
const COMMAND_PATH_RE =
  /(?:^|[\s"'=])([./~A-Za-z0-9_@+-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)(?:$|[\s"',)\]:;])/g;
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/**
 * Every `path:line` reference in a block of text, plus every bare path, sorted
 * by path. Go's regexp finds non-overlapping matches left to right; JS's
 * sticky-free `matchAll` does the same, so the two agree.
 */
export function parsePathHits(text: string): Array<PathHit> {
  const byPath = new Map<string, Array<readonly [number, number]>>();
  for (const match of matchAll(PATH_LINE_RE, text)) {
    const line = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(line) || line <= 0) continue;
    const path = cleanExtractedPath(match[1] ?? "", true);
    if (path === null) continue;
    const lines = byPath.get(path);
    if (lines) lines.push([line, line]);
    else byPath.set(path, [[line, line]]);
  }
  for (const path of extractPaths(text)) {
    if (!byPath.has(path)) byPath.set(path, []);
  }
  return [...byPath.entries()]
    .map(([path, lines]) => ({ path, lines }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

/** Paths that look like paths because they contain a separator — output text. */
export function extractPaths(text: string): Array<string> {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const match of matchAll(PATH_ONLY_RE, text)) {
    const path = cleanExtractedPath(match[1] ?? "", false);
    if (path === null || path === "" || seen.has(path) || path.includes("://")) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths.sort(compareStrings);
}

/**
 * Paths in a command string, where a bare `Makefile` is still a path. Looser
 * than `extractPaths` because a command's arguments are already known to be
 * arguments.
 */
export function extractCommandPaths(command: string): Array<string> {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const match of matchAll(COMMAND_PATH_RE, command)) {
    const path = cleanExtractedPath(match[1] ?? "", true);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths.sort(compareStrings);
}

/** The files an `apply_patch` envelope names. */
export function parsePatchPaths(patch: string): Array<string> {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const match of matchAll(PATCH_FILE_RE, patch)) {
    const raw = match[1] !== undefined && match[1] !== "" ? match[1] : (match[2] ?? "");
    const path = cleanExtractedPath(raw, true);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths.sort(compareStrings);
}

/**
 * mindwalk's `cleanExtractedPath`. `allowTopLevel` is false for output text,
 * where a bare word with a dot is far more likely to be prose than a path.
 */
export function cleanExtractedPath(rawPath: string, allowTopLevel: boolean): string | null {
  let path = trimChars(rawPath.trim(), "\"' ,;:()[]{}");
  path = trimPrefix(path, "a/");
  path = trimPrefix(path, "b/");
  path = trimPrefix(path, "./");
  if (path === "" || path.includes("://") || /[\n\r\t]/.test(path)) return null;
  if (path.startsWith("--") || path.startsWith("++")) return null;
  if (!allowTopLevel && !path.includes("/")) return null;
  return path;
}

function trimPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SEARCH_PROGRAMS = new Set(["grep", "rg", "ag", "find", "fd", "ls", "tree"]);

const READ_ONLY_PROGRAMS = new Set([
  "cd",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "awk",
  "echo",
  "which",
  "file",
  "stat",
  "du",
  "pwd",
  "dirname",
  "basename",
  "true",
]);

const READ_PROGRAMS = new Set(["cat", "head", "tail", "nl", "sed"]);

/**
 * Whether a shell command only inspects the tree the way Grep/Glob/LS would:
 * every pipeline segment runs a read-only program and at least one actually
 * searches or lists. Conservative by design — anything unrecognized stays
 * `exec`, because colouring a file "seen" when it was rewritten is the lie the
 * visualisation cannot afford.
 */
export function searchCommand(command: string): boolean {
  const cleaned = stripRedirections(command);
  let searched = false;
  for (const segment of splitSegments(cleaned)) {
    if (segment.includes(">")) return false;
    const fields = dropEnvAssignments(segment.split(/\s+/).filter((field) => field !== ""));
    if (fields.length === 0) continue;
    const program = NodePath.basename(fields[0]!).toLowerCase();
    if (
      program === "git" &&
      fields.length > 1 &&
      (fields[1] === "grep" || fields[1] === "ls-files")
    ) {
      searched = true;
      continue;
    }
    if (SEARCH_PROGRAMS.has(program)) {
      // find can mutate through -exec/-delete; keep those out of "search"
      if (segment.includes("-exec") || segment.includes("-delete")) return false;
      searched = true;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
  }
  return searched;
}

/**
 * Whether a shell command only pages file contents the way Read would: every
 * segment runs a read-only program and at least one names a file.
 */
export function readCommand(command: string): boolean {
  if (commandReadPaths(command).length === 0) return false;
  const cleaned = stripRedirections(command);
  for (const segment of splitSegments(cleaned)) {
    if (segment.includes(">")) return false;
    const fields = dropEnvAssignments(segment.split(/\s+/).filter((field) => field !== ""));
    if (fields.length === 0) continue;
    const program = NodePath.basename(fields[0]!).toLowerCase();
    if (program === "sed" && !sedReadsOnly(fields.slice(1))) return false;
    if (!READ_ONLY_PROGRAMS.has(program) && !READ_PROGRAMS.has(program)) return false;
  }
  return true;
}

/**
 * The file arguments of pager-style segments — cat/head/tail/nl and the
 * `sed -n '…p' file` idiom — the shell equivalents of opening a file to read
 * it, as opposed to merely naming it.
 */
export function commandReadPaths(command: string): Array<string> {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const segment of splitSegments(command)) {
    if (segment.includes(">")) continue;
    const fields = dropEnvAssignments(segment.split(/\s+/).filter((field) => field !== ""));
    if (fields.length === 0) continue;
    const program = NodePath.basename(fields[0]!).toLowerCase();
    if (!READ_PROGRAMS.has(program)) continue;

    const args = fields.slice(1);
    let scriptArgs = 0;
    if (program === "sed") {
      // only the read idiom: sed -n '…p' file — anything else can rewrite
      if (!sedReadsOnly(args)) continue;
      scriptArgs = 1;
    }
    let expectValue = false;
    for (const arg of args) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (arg.startsWith("-")) {
        expectValue = flagTakesValue(program, arg);
        continue;
      }
      if (scriptArgs > 0) {
        scriptArgs -= 1;
        continue;
      }
      // globs, redirections, and substitutions are not literal file paths
      if (/[<>*?$`]/.test(arg)) continue;
      const path = cleanExtractedPath(arg, true);
      if (path === null || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths.sort(compareStrings);
}

function sedReadsOnly(args: ReadonlyArray<string>): boolean {
  let hasN = false;
  for (const arg of args) {
    if (arg === "-n") hasN = true;
    if (arg.startsWith("-i")) return false;
  }
  return hasN;
}

function flagTakesValue(program: string, flag: string): boolean {
  switch (program) {
    case "head":
    case "tail":
      return flag === "-n" || flag === "-c";
    case "sed":
      return flag === "-e" || flag === "-f";
    default:
      return false;
  }
}

const VERIFY_PATTERNS = [
  "go test",
  "go vet",
  "npm test",
  "npm run build",
  "pnpm test",
  "pnpm build",
  "pytest",
  "make test",
  "cargo test",
  "swift test",
];

/** Whether a command is the session checking its own work. */
export function verifyCommand(command: string): boolean {
  const lowered = command.toLowerCase();
  return VERIFY_PATTERNS.some((pattern) => lowered.includes(pattern));
}

function stripRedirections(command: string): string {
  return command
    .replaceAll("2>&1", " ")
    .replaceAll("2>/dev/null", " ")
    .replaceAll(">/dev/null", " ")
    .replaceAll("> /dev/null", " ");
}

/** Go's `strings.FieldsFunc` over the pipeline separators: no empty segments. */
function splitSegments(command: string): Array<string> {
  return command.split(/[|;&\n]/).filter((segment) => segment !== "");
}

function dropEnvAssignments(fields: ReadonlyArray<string>): Array<string> {
  let index = 0;
  while (index < fields.length && ENV_ASSIGN_RE.test(fields[index]!)) index += 1;
  return fields.slice(index);
}

/** Go sorts strings by byte order; JS's default sort is UTF-16 code units. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function* matchAll(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  // A shared global regex carries `lastIndex` between calls; a fresh one per
  // scan keeps these helpers pure and reentrant.
  const regex = new RegExp(pattern.source, pattern.flags);
  let match = regex.exec(text);
  while (match !== null) {
    yield match;
    if (match[0] === "") regex.lastIndex += 1;
    match = regex.exec(text);
  }
}
