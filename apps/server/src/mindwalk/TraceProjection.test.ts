/**
 * The fold: which activities become events, which become marks, and where a
 * user message lands between them.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  buildTrace,
  parseLens,
  type TraceActivityRow,
  type TraceMessageRow,
} from "./TraceProjection.ts";

const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;

const claudeTool = (
  seconds: number,
  toolName: string,
  input: Record<string, unknown>,
  extra: { itemType?: string; isError?: boolean; content?: string } = {},
): TraceActivityRow => ({
  kind: "tool.completed",
  createdAt: at(seconds),
  payload: {
    itemType: extra.itemType ?? "command_execution",
    data: {
      toolName,
      input,
      result: { content: extra.content ?? "", is_error: extra.isError ?? false },
    },
  },
});

const project = (
  activities: ReadonlyArray<TraceActivityRow>,
  messages: ReadonlyArray<TraceMessageRow> = [],
  lens = parseLens(undefined),
) =>
  buildTrace({
    threadId: "thread-1",
    providerName: "claudeAgent",
    root: "/repo",
    title: "Redesign the growth system",
    model: "claude-opus-5",
    activities,
    messages,
    lens,
    repoPathExists: () => true,
  });

describe("buildTrace", () => {
  it("folds one completed tool call into one event, numbered in order", () => {
    const trace = project([
      claudeTool(1, "Read", { file_path: "/repo/a.ts" }),
      claudeTool(2, "Edit", { file_path: "/repo/a.ts" }),
    ]);
    assert.deepEqual(
      trace.events.map((event) => [event.seq, event.tool, event.action]),
      [
        [0, "Read", "read"],
        [1, "Edit", "edit"],
      ],
    );
    assert.equal(trace.session.eventCount, 2);
    assert.equal(trace.session.startedAt, at(1));
    assert.equal(trace.session.endedAt, at(2));
    assert.equal(trace.session.harness, "claude-code");
    assert.equal(trace.session.cwd, "/repo");
  });

  it("makes a denial an error event that touched nothing", () => {
    const trace = project([
      { kind: "tool.denied", createdAt: at(1), payload: { toolName: "AskUserQuestion" } },
    ]);
    assert.equal(trace.events.length, 1);
    assert.isTrue(trace.events[0]?.isError);
    assert.deepEqual(trace.events[0]?.targets, []);
    assert.equal(trace.stats.errorRate, 1);
  });

  it("turns a compaction into a mark, never an event", () => {
    const trace = project([
      claudeTool(1, "Read", { file_path: "/repo/a.ts" }),
      { kind: "context-compaction", createdAt: at(2), payload: { state: "compacted" } },
      claudeTool(3, "Read", { file_path: "/repo/b.ts" }),
    ]);
    assert.equal(trace.events.length, 2);
    assert.deepEqual(trace.marks, [{ seq: 1, type: "compaction" }]);
    assert.equal(trace.stats.compactions, 1);
  });

  it("makes a subagent launch both a mark and an event, as mindwalk does for Task", () => {
    const trace = project([
      {
        kind: "tool.completed",
        createdAt: at(1),
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "general-purpose: Review architecture",
          data: { toolName: "Agent", input: { description: "Review architecture" }, result: {} },
        },
      },
    ]);
    assert.deepEqual(trace.marks, [
      { seq: 0, type: "subagent", note: "general-purpose: Review architecture" },
    ]);
    assert.equal(trace.events.length, 1);
    assert.equal(trace.stats.subagents, 1);
  });

  it("lands a user message before the activity it caused", () => {
    const messages: ReadonlyArray<TraceMessageRow> = [
      { role: "user", text: "fix the login bug", createdAt: at(1) },
      { role: "assistant", text: "on it", createdAt: at(1) },
      { role: "user", text: "and the logout one", createdAt: at(3) },
    ];
    const trace = project(
      [
        claudeTool(1, "Read", { file_path: "/repo/a.ts" }),
        claudeTool(4, "Edit", { file_path: "/repo/a.ts" }),
      ],
      messages,
    );
    assert.deepEqual(trace.marks, [
      // Same instant as the first activity, and still sorts before it.
      { seq: 0, type: "user-message", note: "fix the login bug" },
      { seq: 1, type: "user-message", note: "and the logout one" },
    ]);
    assert.equal(trace.stats.userTurns, 2);
  });

  it("keeps a trailing user message on the timeline past the last event", () => {
    const trace = project(
      [claudeTool(1, "Read", { file_path: "/repo/a.ts" })],
      [{ role: "user", text: "anything else?", createdAt: at(9) }],
    );
    assert.deepEqual(trace.marks, [{ seq: 1, type: "user-message", note: "anything else?" }]);
  });

  it("keeps a tool call that touched no file, because it is still a bar on the histogram", () => {
    const trace = project([claudeTool(1, "Bash", { command: "echo done" })]);
    assert.equal(trace.events.length, 1);
    assert.deepEqual(trace.events[0]?.targets, []);
    assert.equal(trace.stats.actions.exec, 1);
  });

  it("leaves filesInRepo at zero until the citymap is known", () => {
    const trace = project([claudeTool(1, "Read", { file_path: "/repo/a.ts" })]);
    assert.equal(trace.stats.filesInRepo, 0);
    assert.equal(trace.stats.observability.errors, "exact");
  });
});

describe("lenses", () => {
  const attributed: TraceActivityRow = {
    kind: "tool.completed",
    createdAt: at(2),
    payload: {
      itemType: "command_execution",
      parentToolCallId: "toolu_launch",
      data: { toolName: "Read", input: { file_path: "/repo/b.ts" }, result: {} },
    },
  };
  const launch: TraceActivityRow = {
    kind: "tool.completed",
    createdAt: at(1),
    payload: {
      itemType: "collab_agent_tool_call",
      data: { toolName: "Agent", input: {}, result: { tool_use_id: "toolu_launch" } },
    },
  };

  it("parses the lens parameter, defaulting to main", () => {
    assert.deepEqual(parseLens(undefined), { kind: "main" });
    assert.deepEqual(parseLens("main"), { kind: "main" });
    assert.deepEqual(parseLens("agent:toolu_1"), { kind: "agent", launchCallId: "toolu_1" });
    // A lens naming nothing is a main lens, not an empty trace.
    assert.deepEqual(parseLens("agent:"), { kind: "main" });
  });

  it("drops attributed subagent work from the main lens", () => {
    const trace = project([launch, attributed], [], parseLens("main"));
    assert.equal(trace.events.length, 1);
    assert.equal(trace.events[0]?.tool, "Agent");
  });

  it("keeps a launch and its subtree under that launch's lens", () => {
    const trace = project([launch, attributed], [], parseLens("agent:toolu_launch"));
    assert.deepEqual(
      trace.events.map((event) => event.tool),
      ["Agent", "Read"],
    );
  });

  it("is a no-op today, because nothing writes the attribution edge yet", () => {
    // Every real row lacks `parentToolCallId`, so main keeps everything and an
    // agent lens keeps only its launch — both correct until #20 ships.
    const rows = [
      claudeTool(1, "Read", { file_path: "/repo/a.ts" }),
      claudeTool(2, "Edit", { file_path: "/repo/a.ts" }),
    ];
    assert.equal(project(rows, [], parseLens("main")).events.length, 2);
    assert.equal(project(rows, [], parseLens("agent:toolu_missing")).events.length, 0);
  });
});
