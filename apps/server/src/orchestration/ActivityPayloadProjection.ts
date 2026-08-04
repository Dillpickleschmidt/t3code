import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result && "command" in result) {
    projectedItem.result = { command: result.command };
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }

  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

const FILE_CHANGE_PREVIEW_MAX_LINES = 12;
const FILE_CHANGE_PREVIEW_MAX_CHARS = 2_000;
const FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_LINES = 8;
const FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_CHARS = 1_000;
const FILE_CHANGE_FALLBACK_PATH = "file";

interface CappedPreviewText {
  text: string;
  truncated: boolean;
  hiddenLineCount: number;
}

function capPreviewText(value: string, maxLines: number, maxChars: number): CappedPreviewText {
  const lines = value.split("\n");
  let text = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return {
    text,
    truncated,
    hiddenLineCount: lines.length - text.split("\n").length,
  };
}

function splitPatchLines(text: string): string[] {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.length === 0 ? [] : normalized.split("\n");
}

function buildUnifiedPatch(path: string, oldLines: string[], newLines: string[]): string {
  const oldRange = oldLines.length === 0 ? "-0,0" : `-1,${oldLines.length}`;
  const newRange = newLines.length === 0 ? "+0,0" : `+1,${newLines.length}`;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ ${oldRange} ${newRange} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function wrapDiffWithFileHeader(path: string, diff: string): string {
  const trimmed = diff.replace(/\n+$/u, "");
  if (trimmed.startsWith("diff --git") || trimmed.startsWith("--- ")) {
    return trimmed;
  }
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, trimmed].join("\n");
}

/**
 * The provider shapes a file change can arrive in. Clients never see these:
 * every shape is assembled into one renderable patch server-side.
 *
 * - `write`/`edit` come from Claude-style tool inputs.
 * - `patch` comes from Codex app-server `fileChange` items, which carry
 *   per-file unified diffs in `item.changes[{ path, kind, diff }]` (see
 *   `FileChangeThreadItem` in the generated app-server schema).
 */
type FileChangeSource =
  | { shape: "write"; path: string | null; content: string }
  | { shape: "edit"; path: string | null; oldString: string | null; newString: string | null }
  | { shape: "patch"; path: string | null; sections: string[] };

function readFileChangeSource(data: Record<string, unknown>): FileChangeSource | undefined {
  const input = asRecord(data.input);
  if (input) {
    const path =
      asTrimmedString(input.file_path) ??
      asTrimmedString(input.path) ??
      asTrimmedString(input.filePath) ??
      asTrimmedString(input.notebook_path);

    const oldString = typeof input.old_string === "string" ? input.old_string : null;
    const newString = typeof input.new_string === "string" ? input.new_string : null;
    if (oldString !== null || newString !== null) {
      return { shape: "edit", path, oldString, newString };
    }

    const content =
      typeof input.content === "string"
        ? input.content
        : typeof input.new_source === "string"
          ? input.new_source
          : null;
    if (content === null || content.length === 0) {
      return undefined;
    }
    return { shape: "write", path, content };
  }

  const item = asRecord(data.item);
  const changes = Array.isArray(item?.changes) ? item.changes : null;
  if (!changes) {
    return undefined;
  }
  const sections: string[] = [];
  let firstPath: string | null = null;
  for (const changeValue of changes) {
    const change = asRecord(changeValue);
    const path = asTrimmedString(change?.path);
    const diff = typeof change?.diff === "string" ? change.diff : null;
    if (!path || diff === null || diff.length === 0) {
      continue;
    }
    firstPath ??= path;
    sections.push(wrapDiffWithFileHeader(path, diff));
  }
  if (sections.length === 0) {
    return undefined;
  }
  return { shape: "patch", path: firstPath, sections };
}

/**
 * Assembles the full, uncapped patch for a file-change tool call. Used by
 * `orchestration.getToolCallInput` when a client expands a capped preview.
 */
export function assembleFullFileChangePatch(
  data: Record<string, unknown>,
): { path?: string; patch: string } | undefined {
  const source = readFileChangeSource(data);
  if (!source) {
    return undefined;
  }
  const path = source.path ?? FILE_CHANGE_FALLBACK_PATH;
  const patch =
    source.shape === "write"
      ? buildUnifiedPatch(path, [], splitPatchLines(source.content))
      : source.shape === "edit"
        ? buildUnifiedPatch(
            path,
            splitPatchLines(source.oldString ?? ""),
            splitPatchLines(source.newString ?? ""),
          )
        : source.sections.join("\n");
  return {
    ...(source.path !== null ? { path: source.path } : {}),
    patch,
  };
}

/**
 * A bounded excerpt of a file-change tool call, pre-assembled into a
 * renderable patch so clients stay provider-agnostic. `truncated` tells the
 * client that expanding needs a fetch of the full patch; edit sides are
 * capped independently so a large removal cannot push the addition out of
 * the preview.
 */
function projectFileChangePreview(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const source = readFileChangeSource(data);
  if (!source) {
    return undefined;
  }
  const path = source.path ?? FILE_CHANGE_FALLBACK_PATH;

  let patch: string;
  let truncated: boolean;
  let hiddenLineCount: number;
  if (source.shape === "write") {
    const cap = capPreviewText(
      source.content,
      FILE_CHANGE_PREVIEW_MAX_LINES,
      FILE_CHANGE_PREVIEW_MAX_CHARS,
    );
    patch = buildUnifiedPatch(path, [], splitPatchLines(cap.text));
    truncated = cap.truncated;
    hiddenLineCount = cap.hiddenLineCount;
  } else if (source.shape === "edit") {
    const oldCap =
      source.oldString !== null
        ? capPreviewText(
            source.oldString,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_LINES,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_CHARS,
          )
        : null;
    const newCap =
      source.newString !== null
        ? capPreviewText(
            source.newString,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_LINES,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_CHARS,
          )
        : null;
    patch = buildUnifiedPatch(
      path,
      oldCap ? splitPatchLines(oldCap.text) : [],
      newCap ? splitPatchLines(newCap.text) : [],
    );
    truncated = (oldCap?.truncated ?? false) || (newCap?.truncated ?? false);
    hiddenLineCount = (oldCap?.hiddenLineCount ?? 0) + (newCap?.hiddenLineCount ?? 0);
  } else {
    const cap = capPreviewText(
      source.sections.join("\n"),
      FILE_CHANGE_PREVIEW_MAX_LINES,
      FILE_CHANGE_PREVIEW_MAX_CHARS,
    );
    patch = cap.text;
    truncated = cap.truncated;
    hiddenLineCount = cap.hiddenLineCount;
  }

  return {
    ...(source.path !== null ? { path: source.path } : {}),
    patch,
    hiddenLineCount,
    truncated,
  };
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data || payload.itemType === "mcp_tool_call") {
    return activity;
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data);
  if (item) {
    projectedData.item = item;
  }
  if ("command" in data) {
    projectedData.command = data.command;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const rawOutput = projectRawOutput(data.rawOutput);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  // Activities persisted before toolCallId stamping can't be deduped per call
  // in snapshots, so their streamed updates go without a preview; the final
  // tool.completed activity still gets one.
  if (
    payload.itemType === "file_change" &&
    (asTrimmedString(data.toolCallId) !== null || activity.kind === "tool.completed")
  ) {
    const preview = projectFileChangePreview(data);
    if (preview) {
      projectedData.preview = preview;
    }
  }

  return {
    ...activity,
    payload: {
      ...payload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

function previewToolCallId(activity: OrchestrationThreadActivity): string | null {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return null;
  }
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!data || data.preview === undefined) {
    return null;
  }
  return asTrimmedString(data.toolCallId);
}

/**
 * Clients merge a tool call's streamed activities into one row, so only the
 * newest preview per call is ever rendered. Superseded copies would otherwise
 * multiply snapshot size by the number of streaming updates; strip them when
 * replaying history. Live `thread.activity-appended` events are untouched.
 */
function stripSupersededFileChangePreviews(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByToolCall = new Map<string, number>();
  for (let index = 0; index < activities.length; index += 1) {
    const toolCallId = previewToolCallId(activities[index]!);
    if (toolCallId !== null) {
      latestIndexByToolCall.set(toolCallId, index);
    }
  }
  if (latestIndexByToolCall.size === 0) {
    return activities;
  }
  return activities.map((activity, index) => {
    const toolCallId = previewToolCallId(activity);
    if (toolCallId === null || latestIndexByToolCall.get(toolCallId) === index) {
      return activity;
    }
    const payload = asRecord(activity.payload)!;
    const { preview: _preview, ...data } = asRecord(payload.data)!;
    return {
      ...activity,
      payload: {
        ...payload,
        data,
      },
    };
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: stripSupersededFileChangePreviews(
        dropStaleContextWindowActivities(snapshot.thread.activities).map(projectActivityPayload),
      ),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
