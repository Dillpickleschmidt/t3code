/**
 * The path-scraping half of the port, checked against the Go tests it was
 * translated from. Every case in `TestCommandReadPaths`
 * (`.repos/mindwalk/internal/adapter/adapter_test.go:342-372`) is here
 * verbatim, plus the normalization and extraction edges the Go suite covers
 * only indirectly through `BuildEvent`.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  cleanExtractedPath,
  commandReadPaths,
  extractCommandPaths,
  extractPaths,
  normalizePath,
  parsePathHits,
  parsePatchPaths,
  readCommand,
  searchCommand,
  verifyCommand,
} from "./TraceScrape.ts";

describe("commandReadPaths", () => {
  // Ported case for case from mindwalk's TestCommandReadPaths.
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    [`sed -n '1,240p' internal/adapter/adapter.go`, ["internal/adapter/adapter.go"]],
    [`cat a.go b.go`, ["a.go", "b.go"]],
    [`head -n 20 Makefile`, ["Makefile"]],
    [`tail -f logs/app.log`, ["logs/app.log"]],
    [`cat src/main.go | rg TODO`, ["src/main.go"]],
    [`sed -i '' 's/x/y/' a.go`, []],
    [`cat file.go > copy.go`, []],
    [`grep -rn TODO src`, []],
    [`cat *.go`, []],
    [`cat <<EOF > notes.md`, []],
  ];

  for (const [command, want] of cases) {
    it(`reads ${JSON.stringify(command)}`, () => {
      assert.deepEqual(commandReadPaths(command), [...want]);
    });
  }
});

describe("searchCommand and readCommand", () => {
  // The classification half of TestBuildEventClassifiesBashSearchCommands,
  // asserted directly on the predicates rather than through an event.
  it("recognizes read-only inspection", () => {
    assert.isTrue(searchCommand(`grep -rn "Pair with AI" src --include="*.ts" | head -5`));
    assert.isTrue(searchCommand(`find . -name "*.go" | wc -l`));
    assert.isTrue(searchCommand(`cd /repo && rg TODO internal`));
    assert.isTrue(searchCommand(`git grep -n hook`));
    assert.isTrue(searchCommand(`FOO=1 grep -c x file.txt 2>/dev/null`));
    assert.isTrue(searchCommand(`ls web/src`));
  });

  it("refuses anything that can write", () => {
    assert.isFalse(searchCommand(`grep x file > out.txt`));
    assert.isFalse(searchCommand(`find . -name "*.tmp" -delete`));
    assert.isFalse(searchCommand(`grep x file && rm file`));
    assert.isFalse(searchCommand(`npm install 2>&1 | tail -3`));
    assert.isFalse(searchCommand(`echo done`));
  });

  it("recognizes paging a file", () => {
    assert.isTrue(readCommand(`cat internal/model/stats.go`));
    assert.isTrue(readCommand(`sed -n '1,240p' web/src/ui/Hud.tsx`));
    assert.isTrue(readCommand(`nl -ba main.go | head -50`));
    assert.isTrue(readCommand(`head -n 20 Makefile`));
  });

  it("refuses in-place edits and redirections", () => {
    assert.isFalse(readCommand(`sed -i '' 's/a/b/g' main.go`));
    assert.isFalse(readCommand(`cat notes.md > backup.md`));
    assert.isFalse(readCommand(`cat main.go && rm main.go`));
  });

  it("names the session checking its own work", () => {
    assert.isTrue(verifyCommand(`go test ./... | tail -5`));
    assert.isTrue(verifyCommand(`PNPM_HOME=x pnpm build`));
    assert.isFalse(verifyCommand(`go build ./...`));
  });
});

describe("normalizePath", () => {
  it("makes an absolute path inside the root relative", () => {
    assert.deepEqual(normalizePath("/repo", "", "/repo/src/main.go"), {
      kind: "inside",
      path: "src/main.go",
    });
  });

  it("resolves a relative path against a command workdir", () => {
    assert.deepEqual(normalizePath("/repo", "/repo/sub", "main.go"), {
      kind: "inside",
      path: "sub/main.go",
    });
  });

  it("reports a path outside the root as an outside touch, never as a target", () => {
    const result = normalizePath("/repo", "", "/etc/hosts");
    assert.equal(result.kind, "outside");
    assert.deepEqual(result.kind === "outside" ? result.outside : null, {
      scope: "other",
      path: "/etc/hosts",
    });
  });

  it("rejects urls, escapes, and the root itself", () => {
    assert.equal(normalizePath("/repo", "", "https://example.com/a.go").kind, "none");
    assert.equal(normalizePath("/repo", "", "../outside.go").kind, "none");
    assert.equal(normalizePath("/repo", "", ".").kind, "none");
    assert.equal(normalizePath("/repo", "", "/repo").kind, "outside");
    assert.equal(normalizePath("/repo", "", "a\nb.go").kind, "none");
  });

  it("trims quotes before whitespace, the way Go's Trim/TrimSpace pair does", () => {
    assert.deepEqual(normalizePath("/repo", "", `"  src/a.go  "`), {
      kind: "inside",
      path: "src/a.go",
    });
    // A quoted path with outer spaces keeps its quotes in Go, so the quotes end
    // up inside the path — preserved rather than "fixed".
    const spaced = normalizePath("/repo", "", ` "src/a.go" `);
    assert.deepEqual(spaced, { kind: "inside", path: `"src/a.go"` });
  });
});

describe("path extraction", () => {
  it("keeps only separator-bearing paths out of free text", () => {
    assert.deepEqual(extractPaths("see src/main.go and notes.md for details"), ["src/main.go"]);
  });

  it("accepts a top-level filename in a command, where free text would not", () => {
    // The regex still demands an extension, so a bare `Makefile` is invisible
    // here — `commandReadPaths` is what catches those, from the pager's args.
    assert.deepEqual(extractCommandPaths("head -n 5 notes.md"), ["notes.md"]);
    assert.deepEqual(extractCommandPaths("head -n 5 Makefile"), []);
  });

  it("collects line numbers per path and sorts by path", () => {
    const hits = parsePathHits("z/two.go:12: bad\nq/one.go:3: worse\nq/one.go:9: worst");
    assert.deepEqual(
      hits.map((hit) => hit.path),
      ["q/one.go", "z/two.go"],
    );
    assert.deepEqual(hits[0]?.lines, [
      [3, 3],
      [9, 9],
    ]);
  });

  it("reads the files an apply_patch envelope names", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/main.go",
      "*** Add File: src/new.go",
      "*** End Patch",
    ].join("\n");
    assert.deepEqual(parsePatchPaths(patch), ["src/main.go", "src/new.go"]);
  });

  it("strips diff prefixes and refuses flags", () => {
    assert.equal(cleanExtractedPath("a/src/main.go", false), "src/main.go");
    assert.equal(cleanExtractedPath("--include=*.ts", true), null);
    assert.equal(cleanExtractedPath("notes.md", false), null);
    assert.equal(cleanExtractedPath("notes.md", true), "notes.md");
  });
});
