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

interface CappedPreviewText {
  text: string;
  truncated: boolean;
  totalLines: number;
}

function capPreviewText(value: string, maxLines: number, maxChars: number): CappedPreviewText {
  const lines = value.split("\n");
  let text = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated, totalLines: lines.length };
}

/**
 * A bounded excerpt of a file-change tool call's input so clients can render
 * an inline diff preview without shipping whole files over the socket. The
 * `truncated` flag tells the client whether expanding needs a fetch of the
 * full persisted input.
 */
function projectFileChangePreview(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const input = asRecord(data.input);
  if (!input) {
    return undefined;
  }
  const path =
    asTrimmedString(input.file_path) ??
    asTrimmedString(input.path) ??
    asTrimmedString(input.filePath) ??
    asTrimmedString(input.notebook_path);

  const oldString = typeof input.old_string === "string" ? input.old_string : null;
  const newString = typeof input.new_string === "string" ? input.new_string : null;
  if (oldString !== null || newString !== null) {
    const oldCap =
      oldString !== null
        ? capPreviewText(
            oldString,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_LINES,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_CHARS,
          )
        : null;
    const newCap =
      newString !== null
        ? capPreviewText(
            newString,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_LINES,
            FILE_CHANGE_PREVIEW_EDIT_SIDE_MAX_CHARS,
          )
        : null;
    if (!oldCap && !newCap) {
      return undefined;
    }
    return {
      kind: "edit",
      ...(path ? { path } : {}),
      ...(oldCap ? { oldText: oldCap.text, oldTotalLines: oldCap.totalLines } : {}),
      ...(newCap ? { newText: newCap.text, newTotalLines: newCap.totalLines } : {}),
      truncated: (oldCap?.truncated ?? false) || (newCap?.truncated ?? false),
    };
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
  const contentCap = capPreviewText(
    content,
    FILE_CHANGE_PREVIEW_MAX_LINES,
    FILE_CHANGE_PREVIEW_MAX_CHARS,
  );
  return {
    kind: "write",
    ...(path ? { path } : {}),
    newText: contentCap.text,
    newTotalLines: contentCap.totalLines,
    truncated: contentCap.truncated,
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
