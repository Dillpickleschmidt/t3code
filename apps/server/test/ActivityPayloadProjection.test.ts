import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, type ThreadFeedActivity } from "../../mobile/src/lib/threadActivity.ts";
import { deriveLatestContextWindowSnapshot } from "../../web/src/lib/contextWindow.ts";
import { deriveWorkLogEntries } from "../../web/src/session-logic.ts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "../src/orchestration/ActivityPayloadProjection.ts";

function makeActivity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      title: itemType,
      detail: `${itemType} detail`,
      status: "completed",
      requestKind: "command",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

function makeThread(activities: ReadonlyArray<OrchestrationThreadActivity>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-projection"),
    projectId: ProjectId.make("project-projection"),
    title: "Activity projection",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
}

const fixtures = [
  makeActivity("command", "command_execution", {
    item: {
      command: ["bash", "-lc", "pnpm test"],
      input: { command: "fallback input", ignored: "input bulk" },
      result: { command: "fallback result", aggregatedOutput: "x".repeat(10_000) },
      commandActions: [{ type: "unknown", output: "y".repeat(5_000) }],
    },
    command: "fallback data",
    kind: "execute",
    toolCallId: "tool-command",
    rawOutput: {
      content: "\n```\nfirst useful line\nsecond line",
      stdout: "unused stdout",
      ignored: "raw bulk",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("file-change", "file_change", {
    item: {
      changes: [
        { oldPath: "src/old.ts", newPath: "src/new.ts", patch: "large patch".repeat(1_000) },
        { filePath: "src/second.ts" },
      ],
    },
    ignored: "top-level bulk",
  }),
  makeActivity("dynamic", "dynamic_tool_call", {
    toolCallId: "tool-dynamic",
    rawOutput: {
      stdout: "dynamic summary\nlong output".repeat(1_000),
    },
    ignored: "top-level bulk",
  }),
  makeActivity("collab", "collab_agent_tool_call", {
    kind: "delegate",
    rawOutput: {
      content: "``` \n```",
      stdout: "must not be used when content is present",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("mcp", "mcp_tool_call", {
    item: {
      server: "repository",
      tool: "search",
      arguments: { query: "activity projection" },
      aggregatedOutput: "mcp payload remains available",
    },
    ignored: "MCP data is rendered verbatim",
  }),
  makeActivity("search", "web_search", {
    rawOutput: {
      totalFiles: 42,
      truncated: true,
      content: "ignored because totalFiles wins",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("image", "image_view", {
    ignored: "top-level bulk",
  }),
] satisfies ReadonlyArray<OrchestrationThreadActivity>;

describe("projectActivityPayload", () => {
  function comparableActivity(activity: ThreadFeedActivity) {
    return {
      ...activity,
      fullDetail: activity.getFullDetail(),
      copyText: activity.getCopyText(),
      getFullDetail: undefined,
      getCopyText: undefined,
    };
  }

  function comparableThreadFeed(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return buildThreadFeed(makeThread(activities)).map((entry) =>
      entry.type === "activity-group"
        ? {
            ...entry,
            activities: entry.activities.map(comparableActivity),
          }
        : entry,
    );
  }

  it("drops unread bulk while retaining command, file, tool, and summary inputs", () => {
    const projected = projectActivityPayload(fixtures[0]!);
    expect(projected.payload).toEqual({
      itemType: "command_execution",
      title: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result" },
        },
        command: "fallback data",
        toolCallId: "tool-command",
        kind: "execute",
        rawOutput: { content: "first useful line" },
      },
    });

    expect(projectActivityPayload(fixtures[1]!).payload).toMatchObject({
      data: {
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }, { path: "src/second.ts" }],
      },
    });
  });

  it("passes MCP tool data through unchanged", () => {
    expect(projectActivityPayload(fixtures[4]!)).toBe(fixtures[4]);
  });

  it("keeps current web and mobile derived output identical for every tool item type", () => {
    for (const activity of fixtures) {
      const projected = projectActivityPayload(activity);
      expect(deriveWorkLogEntries([projected])).toEqual(deriveWorkLogEntries([activity]));
      expect(comparableThreadFeed([projected])).toEqual(comparableThreadFeed([activity]));
    }
  });

  it("projects snapshot and event transports without mutating their sources", () => {
    const activity = fixtures[0]!;
    const thread = makeThread([activity]);
    const snapshot = { snapshotSequence: 7, thread };
    const projectedSnapshot = projectThreadDetailSnapshot(snapshot);

    expect(projectedSnapshot.thread.activities[0]).not.toBe(activity);
    expect(snapshot.thread.activities[0]).toBe(activity);

    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: "2026-07-27T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projectedEvent = projectActivityEvent(event);
    expect(projectedEvent).not.toBe(event);
    expect(
      projectedEvent.type === "thread.activity-appended"
        ? projectedEvent.payload.activity
        : undefined,
    ).toEqual(projectActivityPayload(activity));
    expect(event.payload.activity).toBe(activity);
  });
});

describe("file-change preview", () => {
  function makeFileChangeActivity(
    id: string,
    kind: "tool.updated" | "tool.completed",
    data: Record<string, unknown>,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: "Edit",
      payload: {
        itemType: "file_change",
        title: "Edit",
        status: kind === "tool.completed" ? "completed" : "inProgress",
        data,
      },
      turnId: TurnId.make("turn-preview"),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  function projectedPreview(activity: OrchestrationThreadActivity): unknown {
    const payload = projectActivityPayload(activity).payload as {
      data?: { preview?: unknown };
    };
    return payload.data?.preview;
  }

  function expectedWritePatch(path: string, lines: ReadonlyArray<string>): string {
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
  }

  it("attaches a capped preview for write inputs", () => {
    const activity = makeFileChangeActivity("write-short", "tool.updated", {
      toolName: "Write",
      toolCallId: "tool-write",
      input: { file_path: "src/app.ts", content: "line 1\nline 2\nline 3" },
    });
    expect(projectedPreview(activity)).toEqual({
      path: "src/app.ts",
      patch: expectedWritePatch("src/app.ts", ["line 1", "line 2", "line 3"]),
      hiddenLineCount: 0,
      truncated: false,
    });
  });

  it("caps long write content by lines and flags truncation", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const activity = makeFileChangeActivity("write-long", "tool.updated", {
      toolName: "Write",
      toolCallId: "tool-write-long",
      input: { file_path: "src/big.ts", content: lines.join("\n") },
    });
    expect(projectedPreview(activity)).toEqual({
      path: "src/big.ts",
      patch: expectedWritePatch("src/big.ts", lines.slice(0, 12)),
      hiddenLineCount: 28,
      truncated: true,
    });
  });

  it("attaches both sides of an edit input", () => {
    const activity = makeFileChangeActivity("edit", "tool.completed", {
      toolName: "Edit",
      toolCallId: "tool-edit",
      input: {
        file_path: "src/app.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;\nconst b = 3;",
      },
    });
    expect(projectedPreview(activity)).toEqual({
      path: "src/app.ts",
      patch: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,2 @@",
        "-const a = 1;",
        "+const a = 2;",
        "+const b = 3;",
      ].join("\n"),
      hiddenLineCount: 0,
      truncated: false,
    });
  });

  it("skips previews on streamed updates persisted before toolCallId stamping", () => {
    const legacyData = {
      toolName: "Write",
      input: { file_path: "src/app.ts", content: "line 1" },
    };
    expect(
      projectedPreview(makeFileChangeActivity("legacy-updated", "tool.updated", legacyData)),
    ).toBeUndefined();
    // The final activity still gets one — old threads keep a preview per call.
    expect(
      projectedPreview(makeFileChangeActivity("legacy-completed", "tool.completed", legacyData)),
    ).toMatchObject({ truncated: false });
  });

  it("assembles a capped patch preview for Codex file changes", () => {
    // Shape per the Codex app-server protocol (`FileChangeThreadItem`):
    // the adapter persists the notification payload verbatim, so `data.item`
    // carries `changes: [{ path, kind, diff }]` with per-file unified diffs.
    const longDiff = Array.from({ length: 20 }, (_, index) => `+added line ${index + 1}`).join(
      "\n",
    );
    const activity = makeFileChangeActivity("codex-patch", "tool.completed", {
      toolCallId: "item_3",
      item: {
        id: "item_3",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "src/app.ts",
            kind: { type: "update", move_path: null },
            diff: `@@ -1,1 +1,20 @@\n-old line\n${longDiff}`,
          },
          {
            path: "src/other.ts",
            kind: { type: "add" },
            diff: "@@ -0,0 +1,1 @@\n+new file line",
          },
        ],
      },
    });

    const preview = projectedPreview(activity) as {
      path: string;
      patch: string;
      hiddenLineCount: number;
      truncated: boolean;
    };
    expect(preview).toMatchObject({
      path: "src/app.ts",
      truncated: true,
    });
    expect(preview.patch.startsWith("diff --git a/src/app.ts b/src/app.ts")).toBe(true);
    expect(preview.patch.split("\n")).toHaveLength(12);
    // 30 assembled lines (file one: 3 headers + 22 diff; file two: 3 + 2),
    // 12 shown.
    expect(preview.hiddenLineCount).toBe(18);

    const entries = deriveWorkLogEntries([projectActivityPayload(activity)]);
    expect(entries[0]?.filePreview).toMatchObject({ truncated: true, hiddenLineCount: 18 });
  });

  it("keeps the preview only on the newest snapshot activity per tool call", () => {
    const call = (id: string, kind: "tool.updated" | "tool.completed", content: string) =>
      makeFileChangeActivity(id, kind, {
        toolName: "Write",
        toolCallId: "tool-call-a",
        input: { file_path: "src/app.ts", content },
      });
    const other = makeFileChangeActivity("other-call", "tool.completed", {
      toolName: "Write",
      toolCallId: "tool-call-b",
      input: { file_path: "src/other.ts", content: "other content" },
    });

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([
        call("call-a-1", "tool.updated", "line 1"),
        call("call-a-2", "tool.updated", "line 1\nline 2"),
        other,
        call("call-a-3", "tool.completed", "line 1\nline 2\nline 3"),
      ]),
    });

    const previews = projected.thread.activities.map(
      (activity) => (activity.payload as { data?: { preview?: unknown } }).data?.preview,
    );
    expect(previews[0]).toBeUndefined();
    expect(previews[1]).toBeUndefined();
    expect(previews[2]).toMatchObject({ path: "src/other.ts" });
    expect(previews[3]).toMatchObject({ path: "src/app.ts" });
    expect((previews[3] as { patch: string }).patch).toContain("+line 3");
  });

  it("keeps previews on live activity-appended events", () => {
    const activity = makeFileChangeActivity("live-update", "tool.updated", {
      toolName: "Write",
      toolCallId: "tool-live",
      input: { file_path: "src/live.ts", content: "streamed line" },
    });
    const event = {
      sequence: 10,
      eventId: EventId.make("event-live-preview"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-07-27T00:00:03.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(
      projected.type === "thread.activity-appended"
        ? (projected.payload.activity.payload as { data?: { preview?: unknown } }).data?.preview
        : undefined,
    ).toMatchObject({ path: "src/live.ts" });
  });

  it("derives a work log entry with the merged file preview on the web client", () => {
    const updated = makeFileChangeActivity("derive-1", "tool.updated", {
      toolName: "Write",
      toolCallId: "tool-derive",
      input: { file_path: "src/app.ts", content: "line 1" },
    });
    const completed = makeFileChangeActivity("derive-2", "tool.completed", {
      toolName: "Write",
      toolCallId: "tool-derive",
      input: { file_path: "src/app.ts", content: "line 1\nline 2" },
    });

    const entries = deriveWorkLogEntries([
      projectActivityPayload(updated),
      projectActivityPayload(completed),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.filePreview).toEqual({
      path: "src/app.ts",
      patch: expectedWritePatch("src/app.ts", ["line 1", "line 2"]),
      hiddenLineCount: 0,
      truncated: false,
    });
    expect(entries[0]?.id).toBe("derive-2");
  });
});

describe("context-window snapshot dedup", () => {
  function makeContextWindowActivity(
    id: string,
    usedTokens: number,
    turn = `turn-${id}`,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 200_000 },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  it("keeps only the latest context-window activity per turn in snapshots", () => {
    const stale1 = makeContextWindowActivity("ctx-1", 1_000, "turn-a");
    const latestA = makeContextWindowActivity("ctx-2", 2_000, "turn-a");
    const latestB = makeContextWindowActivity("ctx-3", 3_000, "turn-b");
    const tool = fixtures[0]!;

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([stale1, tool, latestA, latestB]),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      tool.id,
      latestA.id,
      latestB.id,
    ]);
    // The retained rows keep their payloads untouched — the tool-data
    // projection only rewrites payloads with a `data` record.
    expect(projected.thread.activities[2]?.payload).toEqual(latestB.payload);
  });

  it("still resolves a meter value after the client reverts the newest turn", () => {
    // A live thread.reverted makes the client drop all activities from
    // discarded turns; each surviving turn must keep a usable row.
    const olderTurn = makeContextWindowActivity("ctx-old", 1_500, "turn-kept");
    const revertedTurn = makeContextWindowActivity("ctx-new", 9_000, "turn-reverted");

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([olderTurn, revertedTurn]),
    });
    const afterRevert = projected.thread.activities.filter(
      (activity) => activity.turnId === TurnId.make("turn-kept"),
    );

    expect(deriveLatestContextWindowSnapshot(afterRevert)).toEqual(
      deriveLatestContextWindowSnapshot([olderTurn]),
    );
  });

  it("matches what the web client derives from the full history", () => {
    const activities = [
      makeContextWindowActivity("ctx-1", 1_000),
      makeContextWindowActivity("ctx-2", 2_000),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot(activities),
    );
  });

  it("does not let a malformed row shadow an earlier valid row in the same turn", () => {
    const valid = makeContextWindowActivity("ctx-valid", 5_000, "turn-a");
    const malformed: OrchestrationThreadActivity = {
      ...makeContextWindowActivity("ctx-broken", 0, "turn-a"),
      payload: { usedTokens: null },
    };

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([valid, malformed]),
    });

    // The malformed row passes through, the valid row survives, and the
    // client's backward walk resolves the same value as with full history.
    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      valid.id,
      malformed.id,
    ]);
    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot([valid, malformed]),
    );
  });

  it("leaves snapshots without context-window activities untouched", () => {
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([fixtures[4]!]),
    });
    expect(projected.thread.activities).toEqual([fixtures[4]]);
  });

  it("does not filter live activity-appended events", () => {
    const activity = makeContextWindowActivity("ctx-live", 4_000);
    const event = {
      sequence: 9,
      eventId: EventId.make("event-ctx"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-07-27T00:00:02.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(
      projected.type === "thread.activity-appended" ? projected.payload.activity : undefined,
    ).toEqual(activity);
  });
});
