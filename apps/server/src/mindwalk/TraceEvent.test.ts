/**
 * The event builder, checked against the Go tests it was translated from:
 * `TestBuildEventClassifiesBashSearchCommands` and
 * `TestSummarizeToolTruncatesCommandAtRuneBoundary`
 * (`.repos/mindwalk/internal/adapter/adapter_test.go`), plus the per-tool
 * target extraction those tests exercise through the Claude adapter.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  actionFor,
  buildEvent,
  contentToString,
  summarizeTool,
  truncateRunes,
} from "./TraceEvent.ts";

const ROOT = "/repo";
/** Every scraped path is treated as present, so weak targets survive. */
const allExist = () => true;
const noneExist = () => false;

const event = (
  tool: string,
  input: Record<string, unknown>,
  result = "",
  exists = allExist,
  isError = false,
) => buildEvent(ROOT, 0, { tool, input }, { content: result, isError }, exists);

describe("actionFor", () => {
  // Ported case for case from TestBuildEventClassifiesBashSearchCommands.
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`grep -rn "Pair with AI" src --include="*.ts" | head -5`, "search"],
    [`find . -name "*.go" | wc -l`, "search"],
    [`cd /repo && rg TODO internal`, "search"],
    [`git grep -n hook`, "search"],
    [`FOO=1 grep -c x file.txt 2>/dev/null`, "search"],
    [`ls web/src`, "search"],
    [`grep x file > out.txt`, "exec"],
    [`find . -name "*.tmp" -delete`, "exec"],
    [`grep x file && rm file`, "exec"],
    [`npm install 2>&1 | tail -3`, "exec"],
    [`echo done`, "exec"],
    [`go test ./... | tail -5`, "verify"],
    [`cat internal/model/stats.go`, "read"],
    [`sed -n '1,240p' web/src/ui/Hud.tsx`, "read"],
    [`nl -ba main.go | head -50`, "read"],
    [`head -n 20 Makefile`, "read"],
    [`sed -i '' 's/a/b/g' main.go`, "exec"],
    [`cat notes.md > backup.md`, "exec"],
    [`cat main.go && rm main.go`, "exec"],
  ];

  for (const [command, want] of cases) {
    it(`classifies ${JSON.stringify(command)} as ${want}`, () => {
      assert.equal(actionFor("Bash", { command }), want);
    });
  }

  it("classifies the first-class tools by name", () => {
    assert.equal(actionFor("Read", {}), "read");
    assert.equal(actionFor("Edit", {}), "edit");
    assert.equal(actionFor("Write", {}), "edit");
    assert.equal(actionFor("apply_patch", {}), "edit");
    assert.equal(actionFor("Grep", {}), "search");
    assert.equal(actionFor("Glob", {}), "search");
    assert.equal(actionFor("WebSearch", {}), "other");
  });
});

describe("targets", () => {
  it("reads Read's snake_case file_path, with its line range", () => {
    const result = event("Read", { file_path: "/repo/src/main.ts", offset: 10, limit: 5 });
    assert.deepEqual(result.targets, [{ path: "src/main.ts", touch: "read", lines: [[10, 14]] }]);
  });

  it("marks an Edit as an edit and never as weak", () => {
    assert.deepEqual(event("Edit", { file_path: "/repo/src/main.ts" }).targets, [
      { path: "src/main.ts", touch: "edit" },
    ]);
  });

  it("counts Grep's output hits, falling back to the weak search root", () => {
    const hits = event(
      "Grep",
      { path: "src" },
      "/repo/src/a.ts:12: match\n/repo/src/b.ts:3: match",
    );
    assert.deepEqual(
      hits.targets.map((target) => target.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.isUndefined(hits.targets[0]?.weak);

    const empty = event("Grep", { path: "src" }, "");
    assert.deepEqual(empty.targets, [{ path: "src", touch: "hit", weak: true }]);
  });

  it("scrapes Bash, which is where two thirds of all touches actually live", () => {
    const result = event("Bash", { command: "cat src/main.ts | rg TODO src/other.ts" });
    assert.deepEqual(result.targets, [
      { path: "src/main.ts", touch: "read", weak: true },
      { path: "src/other.ts", touch: "hit", weak: true },
    ]);
    // search outranks read in mindwalk's ladder: one `rg` segment is enough.
    assert.equal(result.action, "search");
  });

  it("drops a scraped path that does not exist, because it was only a guess", () => {
    const result = event("Bash", { command: "cat src/imaginary.ts" }, "", noneExist);
    assert.deepEqual(result.targets, []);
  });

  it("keeps the strongest touch when a path is seen twice in one call", () => {
    const result = event("Bash", { command: "rg TODO src/main.ts; cat src/main.ts" });
    assert.deepEqual(result.targets, [{ path: "src/main.ts", touch: "read", weak: true }]);
  });

  it("tallies a path outside the repository instead of targeting it", () => {
    const result = event("Read", { file_path: "/etc/hosts" });
    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.outside, [{ scope: "other", path: "/etc/hosts" }]);
  });

  it("lets a typed seed outrank the same path scraped a moment later", () => {
    const result = buildEvent(
      ROOT,
      0,
      {
        tool: "exec_command",
        input: { cmd: "cat src/main.ts", workdir: "/repo" },
        seeds: [{ path: "/repo/src/main.ts", touch: "read" }],
      },
      { content: "", isError: false },
      allExist,
    );
    // Not weak: the provider's own parser resolved this one.
    assert.deepEqual(result.targets, [{ path: "src/main.ts", touch: "read" }]);
  });
});

describe("summarizeTool", () => {
  it("truncates a long command at a rune boundary, marker included", () => {
    // Ported from TestSummarizeToolTruncatesCommandAtRuneBoundary.
    const command = "a".repeat(92) + "界tail";
    assert.equal(
      summarizeTool("Bash", { cmd: command }, 0, 0, false),
      "a".repeat(92) + "界... -> 0 targets, 0 outside",
    );
  });

  it("prefers the tool's own description, and flags an error", () => {
    assert.equal(
      summarizeTool("Read", { description: "look" }, 1, 0, true),
      "look -> 1 targets, 0 outside error",
    );
  });
});

describe("truncateRunes", () => {
  it("passes text at the limit through untouched", () => {
    const exact = "字".repeat(240);
    assert.equal(truncateRunes(exact, 240, "…"), exact);
  });

  it("keeps the marker inside the budget", () => {
    const truncated = truncateRunes("字".repeat(241), 240, "…");
    assert.equal([...truncated].length, 240);
    assert.isTrue(truncated.endsWith("…"));
  });
});

describe("contentToString", () => {
  it("reads Claude's block list and its bare-string form alike", () => {
    assert.equal(contentToString("plain"), "plain");
    assert.equal(contentToString([{ type: "text", text: "a" }, { content: "b" }]), "a\nb");
    assert.equal(contentToString(null), "");
  });
});
