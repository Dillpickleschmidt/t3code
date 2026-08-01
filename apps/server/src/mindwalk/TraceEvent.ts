/**
 * TraceEvent - turning one tool call into one event on the timeline.
 *
 * A near-verbatim port of `actionFor`, `targetsFor`, `BuildEvent` and
 * `SummarizeTool` from mindwalk's `internal/adapter/adapter.go` (MIT,
 * © 2026 Ricko Yu).
 *
 * The vocabulary is mindwalk's, not T3's: a `ToolCall` is `{ tool, input,
 * result }` and the tool names are Claude's and Codex's upstream names. That is
 * the seam — each provider adapter in `ProviderTraceAdapter.ts` reshapes a T3
 * activity into this shape, and everything downstream is provider-agnostic.
 *
 * ## Deviations from upstream
 *
 * - **No `exec` / `js` / `js_repl` branches.** Those parse Codex's free-form
 *   JavaScript orchestration wrapper out of its rollout JSONL. T3 talks to the
 *   Codex app-server, which delivers a `commandExecution` item with a plain
 *   shell string, so the ~200 lines of JS-source parsing behind them would be
 *   unreachable code.
 * - **`seeds`.** Adapters may hand in targets they read from a typed field
 *   (Codex's `commandActions[]`, ACP's `locations[]`). They go through the same
 *   merge as scraped targets, so the strongest touch still wins per path.
 *
 * @module TraceEvent
 */
import type { TraceAction, TraceEvent, TraceTarget, TraceTouch } from "@t3tools/contracts";

import {
  commandReadPaths,
  extractCommandPaths,
  extractPaths,
  normalizePath,
  parsePathHits,
  parsePatchPaths,
  readCommand,
  searchCommand,
  verifyCommand,
  type OutsideTouch,
} from "./TraceScrape.ts";

/** One tool call, in mindwalk's shape, after a provider adapter has reshaped it. */
export interface ToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly timestamp?: string;
  /**
   * Targets the provider handed us from a typed field rather than text. Never
   * weak: the provider's own parser saw the real path.
   */
  readonly seeds?: ReadonlyArray<SeedTarget>;
}

export interface SeedTarget {
  readonly path: string;
  readonly touch: TraceTouch;
  /** The command's own working directory, when the path is relative to one. */
  readonly base?: string;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** Answers whether a repo-relative path exists, for pruning guessed targets. */
export type RepoPathExists = (relativePath: string) => boolean;

/** mindwalk's `RankTouch`: a file keeps the strongest touch it ever received. */
export function rankTouch(touch: string | undefined): number {
  switch (touch) {
    case "edit":
      return 3;
    case "read":
      return 2;
    case "hit":
      return 1;
    default:
      return 0;
  }
}

/** What the tool did, as the histogram and the action legend name it. */
export function actionFor(tool: string, input: Record<string, unknown>): TraceAction {
  switch (tool) {
    case "Read":
      return "read";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "apply_patch":
      return "edit";
    case "Grep":
    case "Glob":
    case "LS":
    case "view_image":
      return "search";
    case "Bash":
    case "exec_command":
    case "write_stdin": {
      const command = firstString(input, "command", "cmd", "code", "chars", "script", "_raw");
      if (verifyCommand(command)) return "verify";
      if (searchCommand(command)) return "search";
      if (readCommand(command)) return "read";
      return "exec";
    }
    default:
      return "other";
  }
}

/**
 * Every file the tool call touched, split into targets inside the repository
 * and a tally of touches outside it.
 *
 * A target scraped out of command or output text is **weak**: it is a guess,
 * so it is dropped unless the file actually exists, never raises a ghost
 * building, and downgrades the read-confidence grade. A target read from a
 * typed field is not.
 */
export function targetsFor(
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
  result: string,
  repoPathExists: RepoPathExists,
  seeds: ReadonlyArray<SeedTarget> = [],
): { targets: Array<TraceTarget>; outside: Array<OutsideTouch> } {
  const targets: Array<Mutable<TraceTarget>> = [];
  const outside: Array<OutsideTouch> = [];

  const add = (
    rawPath: string,
    touch: TraceTouch,
    weak: boolean,
    lines: ReadonlyArray<readonly [number, number]> | undefined,
    base: string,
  ) => {
    const normalized = normalizePath(cwd, base, rawPath);
    if (normalized.kind === "none") return;
    if (normalized.kind === "outside") {
      outside.push(normalized.outside);
      return;
    }
    const path = normalized.path;
    if (weak && !repoPathExists(path)) return;
    const existing = targets.find((target) => target.path === path);
    if (existing) {
      if (rankTouch(touch) > rankTouch(existing.touch)) existing.touch = touch;
      if (lines !== undefined && lines.length > 0) {
        existing.lines = [...(existing.lines ?? []), ...lines];
      }
      return;
    }
    targets.push({
      path,
      touch,
      ...(lines !== undefined && lines.length > 0 ? { lines: [...lines] } : {}),
      ...(weak ? { weak } : {}),
    });
  };

  // Typed targets first, so a path the provider actually resolved outranks the
  // same path guessed out of the command string a moment later.
  for (const seed of seeds) add(seed.path, seed.touch, false, undefined, seed.base ?? "");

  switch (tool) {
    case "Read": {
      const path = stringAt(input, "file_path");
      if (path !== null) add(path, "read", false, readLines(input), "");
      break;
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = stringAt(input, "file_path");
      if (path !== null) add(path, "edit", false, undefined, "");
      const notebookPath = stringAt(input, "notebook_path");
      if (notebookPath !== null) add(notebookPath, "edit", false, undefined, "");
      break;
    }
    case "Grep": {
      for (const hit of parsePathHits(result)) add(hit.path, "hit", false, hit.lines, "");
      if (targets.length === 0) {
        const path = stringAt(input, "path");
        if (path !== null) add(path, "hit", true, undefined, "");
      }
      break;
    }
    case "Glob":
    case "LS": {
      for (const hit of parsePathHits(result)) add(hit.path, "hit", false, undefined, "");
      const path = stringAt(input, "path");
      if (path !== null && targets.length === 0) add(path, "hit", true, undefined, "");
      break;
    }
    case "Bash": {
      const command = firstString(input, "command");
      for (const path of commandReadPaths(command)) add(path, "read", true, undefined, "");
      for (const path of extractCommandPaths(command)) add(path, "hit", true, undefined, "");
      for (const path of extractPaths(`${command}\n${result}`))
        add(path, "hit", true, undefined, "");
      break;
    }
    case "exec_command": {
      const command = firstString(input, "cmd", "command");
      const base = firstString(input, "workdir");
      for (const path of commandReadPaths(command)) add(path, "read", true, undefined, base);
      for (const path of extractCommandPaths(command)) add(path, "hit", true, undefined, base);
      for (const path of extractPaths(`${command}\n${result}`))
        add(path, "hit", true, undefined, base);
      for (const hit of parsePathHits(result)) add(hit.path, "hit", true, hit.lines, base);
      break;
    }
    case "apply_patch": {
      const patch = firstString(input, "patch", "input", "_raw");
      for (const path of parsePatchPaths(patch)) add(path, "edit", false, undefined, "");
      break;
    }
    case "view_image": {
      const path = firstString(input, "path");
      if (path !== "") add(path, "read", false, undefined, "");
      break;
    }
    default:
      break;
  }

  return { targets, outside };
}

const TOOL_SUMMARY_VERB_LIMIT = 96;

/** The one-line description the inspector shows for an event. */
export function summarizeTool(
  tool: string,
  input: Record<string, unknown>,
  targetCount: number,
  outsideCount: number,
  isError: boolean,
): string {
  let verb = tool;
  const description = stringAt(input, "description");
  if (description !== null && description !== "") verb = description;
  const command = firstString(input, "command", "cmd");
  if (command !== "") verb = truncateRunes(command, TOOL_SUMMARY_VERB_LIMIT, "...");
  const status = isError ? " error" : "";
  return `${verb} -> ${targetCount} targets, ${outsideCount} outside${status}`;
}

/** mindwalk's `BuildEvent`: one tool call, folded into one timeline event. */
export function buildEvent(
  cwd: string,
  seq: number,
  call: ToolCall,
  result: ToolResult,
  repoPathExists: RepoPathExists,
): TraceEvent {
  const action = actionFor(call.tool, call.input);
  const { targets, outside } = targetsFor(
    cwd,
    call.tool,
    call.input,
    result.content,
    repoPathExists,
    call.seeds ?? [],
  );
  return {
    seq,
    ...(call.timestamp !== undefined && call.timestamp !== "" ? { ts: call.timestamp } : {}),
    tool: call.tool,
    action,
    targets,
    ...(outside.length > 0 ? { outside } : {}),
    resultBytes: byteLength(result.content),
    isError: result.isError,
    summary: summarizeTool(call.tool, call.input, targets.length, outside.length, result.isError),
  };
}

/**
 * mindwalk's `ContentToString`: Claude's tool result content is a string, or a
 * list of blocks with `text` / `content`, or something else entirely.
 */
export function contentToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: Array<string> = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record["text"] === "string") parts.push(record["text"]);
      if (typeof record["content"] === "string") parts.push(record["content"]);
    }
    return parts.join("\n");
  }
  return JSON.stringify(value) ?? "";
}

/** Go measures `len(result.Content)` in bytes, and `resultBytes` is a budget. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function readLines(input: Record<string, unknown>): Array<readonly [number, number]> | undefined {
  const offset = intFromUnknown(input["offset"]);
  const limit = intFromUnknown(input["limit"]);
  if (offset <= 0) return undefined;
  if (limit <= 0) return [[offset, offset]];
  return [[offset, offset + limit - 1]];
}

function intFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function stringAt(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function firstString(input: Record<string, unknown>, ...keys: ReadonlyArray<string>): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** mindwalk truncates by rune, never mid-codepoint; the marker is included. */
export function truncateRunes(text: string, limit: number, marker: string): string {
  const runes = [...text];
  if (runes.length <= limit) return text;
  const markerRunes = [...marker];
  if (markerRunes.length >= limit) return markerRunes.slice(0, limit).join("");
  return runes.slice(0, limit - markerRunes.length).join("") + marker;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
