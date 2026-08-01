/**
 * The provider seam. The Claude and Codex fixtures below are trimmed copies of
 * real `projection_thread_activities.payload_json` rows, so they pin the shapes
 * T3 actually stores rather than the shapes the SDKs document.
 *
 * ACP and OpenCode are unobserved, so nothing here asserts their happy path —
 * only that an unfamiliar shape degrades to a target-less event instead of
 * throwing or vanishing.
 */
import { assert, describe, it } from "@effect/vitest";

import { adaptDenial, adapterFor } from "./ProviderTraceAdapter.ts";

describe("Claude", () => {
  const adapter = adapterFor("claudeAgent");

  it("passes the stored payload through, because it already is mindwalk's shape", () => {
    const adapted = adapter.adapt({
      itemType: "command_execution",
      data: {
        toolName: "Bash",
        input: { command: "cmake --version", description: "Check toolchain" },
        result: {
          tool_use_id: "toolu_01",
          type: "tool_result",
          content: "cmake 4.4.0",
          is_error: false,
        },
      },
    });
    assert.deepEqual(adapted?.call.tool, "Bash");
    assert.deepEqual(adapted?.call.input, {
      command: "cmake --version",
      description: "Check toolchain",
    });
    assert.deepEqual(adapted?.result, { content: "cmake 4.4.0", isError: false });
    assert.equal(adapter.errorSignal, "exact");
  });

  it("reads is_error structurally, which is what makes its error grade exact", () => {
    const adapted = adapter.adapt({
      itemType: "command_execution",
      data: { toolName: "Bash", input: {}, result: { content: "boom", is_error: true } },
    });
    assert.isTrue(adapted?.result.isError);
  });

  it("files a Read under dynamic_tool_call, and is classified by name anyway", () => {
    // T3's own item typing calls this `dynamic_tool_call`; branching on
    // `toolName` is what keeps every read in the repo visible.
    const adapted = adapter.adapt({
      itemType: "dynamic_tool_call",
      data: { toolName: "Read", input: { file_path: "/repo/a.ts" }, result: { content: "x" } },
    });
    assert.equal(adapted?.call.tool, "Read");
    assert.deepEqual(adapted?.call.input, { file_path: "/repo/a.ts" });
  });

  it("drops a payload with no tool name rather than inventing one", () => {
    assert.isNull(adapter.adapt({ itemType: "web_search", data: { item: {} } }));
  });
});

describe("Codex", () => {
  const adapter = adapterFor("codex");

  it("reads commandActions, which the adapter had been storing and ignoring", () => {
    const adapted = adapter.adapt({
      itemType: "command_execution",
      data: {
        item: {
          type: "commandExecution",
          command: `/bin/bash -lc "sed -n '1,240p' /repo/SKILL.md"`,
          commandActions: [
            {
              command: "sed -n '1,240p' /repo/SKILL.md",
              name: "SKILL.md",
              path: "/repo/SKILL.md",
              type: "read",
            },
          ],
          cwd: "/repo",
          exitCode: 0,
          status: "completed",
          aggregatedOutput: "---\nname: skill\n",
        },
      },
    });
    assert.equal(adapted?.call.tool, "exec_command");
    assert.deepEqual(adapted?.call.input, {
      cmd: `/bin/bash -lc "sed -n '1,240p' /repo/SKILL.md"`,
      workdir: "/repo",
    });
    // Not weak: Codex's own sandbox parser resolved the path, so reporting
    // "estimated" read confidence for it would be the lie the grade prevents.
    assert.deepEqual(adapted?.call.seeds, [
      { path: "/repo/SKILL.md", touch: "read", base: "/repo" },
    ]);
  });

  it("lets a `type: unknown` action fall through to the scraping path", () => {
    const adapted = adapter.adapt({
      itemType: "command_execution",
      data: {
        item: {
          command: "mindwalk --help",
          commandActions: [{ command: "mindwalk --help", type: "unknown" }],
          cwd: "/repo",
          exitCode: 0,
          status: "completed",
        },
      },
    });
    assert.deepEqual(adapted?.call.seeds, []);
  });

  it("reads failure from exitCode and status, not from output text", () => {
    const failed = adapter.adapt({
      itemType: "command_execution",
      data: { item: { command: "curl x", cwd: "/repo", exitCode: 123, status: "failed" } },
    });
    assert.isTrue(failed?.result.isError);
    assert.equal(adapter.errorSignal, "exact");
  });

  it("takes a file change's paths structurally, with no patch to parse", () => {
    const adapted = adapter.adapt({
      itemType: "file_change",
      data: { item: { type: "fileChange", changes: [{ path: "/repo/src/a.ts", kind: "modify" }] } },
    });
    assert.equal(adapted?.call.tool, "apply_patch");
    assert.deepEqual(adapted?.call.seeds, [{ path: "/repo/src/a.ts", touch: "edit" }]);
  });

  it("keeps a tool-less item on the histogram with no targets", () => {
    const adapted = adapter.adapt({
      itemType: "web_search",
      data: { item: { type: "webSearch", query: "tailscale funnel" } },
    });
    assert.equal(adapted?.call.tool, "web_search");
    assert.deepEqual(adapted?.call.seeds, undefined);
  });
});

describe("unobserved providers", () => {
  it("degrades an unknown ACP shape to a target-less event", () => {
    const adapted = adapterFor("cursor").adapt({
      itemType: "dynamic_tool_call",
      data: { kind: "think" },
    });
    assert.equal(adapted?.call.tool, "think");
    assert.deepEqual(adapted?.call.seeds, []);
    assert.equal(adapterFor("cursor").errorSignal, "estimated");
  });

  it("keeps whatever locations an ACP agent volunteered, at the weakest touch", () => {
    const adapted = adapterFor("grok").adapt({
      itemType: "dynamic_tool_call",
      data: { kind: "other", locations: [{ path: "/repo/a.ts" }] },
    });
    assert.deepEqual(adapted?.call.seeds, [{ path: "/repo/a.ts", touch: "hit" }]);
  });

  it("degrades an unknown OpenCode shape without throwing", () => {
    const adapted = adapterFor("opencode").adapt({
      itemType: "dynamic_tool_call",
      data: { tool: "mystery" },
    });
    assert.equal(adapted?.call.tool, "mystery");
    assert.deepEqual(adapted?.result, { content: "", isError: false });
  });

  it("reads an unnamed provider's payload by shape rather than guessing one", () => {
    // A thread whose session row is gone must not render a dark, empty city
    // just because we could not name its provider.
    const unnamed = adapterFor(null);
    assert.equal(unnamed.harness, "unknown");
    assert.equal(
      unnamed.adapt({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/repo/a.ts" }, result: { content: "x" } },
      })?.call.tool,
      "Read",
    );
    assert.equal(
      unnamed.adapt({
        itemType: "command_execution",
        data: { item: { command: "ls", cwd: "/repo", status: "completed" } },
      })?.call.tool,
      "exec_command",
    );
    assert.isNotNull(
      adapterFor("someFutureProvider").adapt({ itemType: "dynamic_tool_call", data: {} }),
    );
  });
});

describe("denials", () => {
  it("becomes an error event that touched nothing", () => {
    const adapted = adaptDenial({ toolName: "AskUserQuestion", toolUseId: "toolu_01" });
    assert.equal(adapted?.call.tool, "AskUserQuestion");
    assert.deepEqual(adapted?.result, { content: "", isError: true });
  });

  it("is dropped when the payload names no tool", () => {
    assert.isNull(adaptDenial({ toolUseId: "toolu_01" }));
  });
});
