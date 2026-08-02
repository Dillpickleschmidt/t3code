/**
 * The NUL-separated grammar `git log --numstat -z --format=...` prints is
 * unforgiving: an empty field means "a commit header starts here", and a
 * commit with an empty subject, or with no diff at all, produces empty fields
 * that are *not* headers. Every one of these cases is a real commit shape
 * (`--allow-empty`, `--allow-empty-message`, a merge that changed nothing
 * against its first parent), and getting one wrong silently shifts every
 * later step's changes onto the wrong commit.
 *
 * The fixtures below are byte-for-byte what git 2.55 produced for those cases;
 * `\0` is git's field terminator and `\n` is the line it prints after a
 * header that has records.
 */
import { assert, describe, it } from "@effect/vitest";

import { parseNumstat } from "../vcs/numstat.ts";
import { ghostPathsOf, parseCommitLog } from "./DiffOverlay.ts";

const NUL = "\0";

/** A commit header as the `%x00%H%x00%ct%x00%s` format emits it under `-z`. */
const header = (sha: string, epoch: number, subject: string) =>
  `${NUL}${sha}${NUL}${epoch}${NUL}${subject}${NUL}`;

/** One `--numstat -z` record. */
const record = (additions: string, deletions: string, path: string) =>
  `${additions}\t${deletions}\t${path}${NUL}`;

describe("parseCommitLog", () => {
  it("reads commits oldest to newest with their per-file counts", () => {
    const steps = parseCommitLog(
      header("aaa1", 1_700_000_000, "first") +
        "\n" +
        record("2", "0", "a.txt") +
        record("1", "0", "gone.txt") +
        header("bbb2", 1_700_000_060, "second") +
        "\n" +
        record("0", "1", "gone.txt"),
    );

    assert.deepEqual(steps, [
      {
        id: "aaa1",
        kind: "commit",
        title: "first",
        committedAt: "2023-11-14T22:13:20.000Z",
        files: [
          { path: "a.txt", additions: 2, deletions: 0 },
          { path: "gone.txt", additions: 1, deletions: 0 },
        ],
      },
      {
        id: "bbb2",
        kind: "commit",
        title: "second",
        committedAt: "2023-11-14T22:14:20.000Z",
        files: [{ path: "gone.txt", additions: 0, deletions: 1 }],
      },
    ]);
  });

  it("keeps a commit that changed nothing as its own step", () => {
    const steps = parseCommitLog(
      header("aaa1", 1_700_000_000, "first") +
        "\n" +
        record("1", "0", "a.txt") +
        header("bbb2", 1_700_000_060, "empty one") +
        header("ccc3", 1_700_000_120, "last") +
        "\n" +
        record("1", "0", "a.txt"),
    );

    assert.deepEqual(
      steps.map((step) => [step.id, step.files.length]),
      [
        ["aaa1", 1],
        ["bbb2", 0],
        ["ccc3", 1],
      ],
    );
  });

  it("does not mistake an empty subject for the next commit header", () => {
    const steps = parseCommitLog(
      header("aaa1", 1_700_000_000, "") + header("bbb2", 1_700_000_060, "after the blank one"),
    );

    assert.deepEqual(
      steps.map((step) => [step.id, step.title]),
      [
        ["aaa1", ""],
        ["bbb2", "after the blank one"],
      ],
    );
  });

  it("gives a binary file a building and no height", () => {
    const steps = parseCommitLog(
      header("aaa1", 1_700_000_000, "add a png") + "\n" + record("-", "-", "logo.png"),
    );

    assert.deepEqual(steps[0]?.files, [{ path: "logo.png", additions: 0, deletions: 0 }]);
  });

  it("returns nothing for an empty range", () => {
    assert.deepEqual(parseCommitLog(""), []);
  });
});

describe("parseNumstat", () => {
  it("reads a plain working-tree diff", () => {
    assert.deepEqual(parseNumstat(record("1", "0", "a.txt") + record("0", "3", "b.txt")), [
      { path: "a.txt", additions: 1, deletions: 0 },
      { path: "b.txt", additions: 0, deletions: 3 },
    ]);
  });

  it("takes the destination path when git splits the name across fields", () => {
    // What `git diff --numstat -z --no-index -- /dev/null u.txt` prints for an
    // untracked file: an empty name, then the two sides.
    assert.deepEqual(parseNumstat(`2\t0\t${NUL}/dev/null${NUL}u.txt${NUL}`), [
      { path: "u.txt", additions: 2, deletions: 0 },
    ]);
  });

  it("returns nothing for a clean tree", () => {
    assert.deepEqual(parseNumstat(""), []);
  });
});

describe("ghostPathsOf", () => {
  it("collects every path any step touched, once", () => {
    const step = (id: string, paths: ReadonlyArray<string>) => ({
      id,
      kind: "commit" as const,
      title: id,
      committedAt: "2023-11-14T22:13:20.000Z",
      files: paths.map((path) => ({ path, additions: 1, deletions: 0 })),
    });

    assert.deepEqual(ghostPathsOf([step("a", ["a.txt", "b.txt"]), step("b", ["b.txt", "c.txt"])]), [
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });

  // A file deleted but not committed is in no step, and gone from the tree the
  // city is built from — so without this it has nowhere to draw at all.
  it("includes uncommitted deletions, and still dedupes", () => {
    const step = {
      id: "a",
      kind: "commit" as const,
      title: "a",
      committedAt: "2023-11-14T22:13:20.000Z",
      files: [{ path: "kept.txt", additions: 1, deletions: 0 }],
    };

    assert.deepEqual(ghostPathsOf([step], ["dropped.txt", "kept.txt", ""]), [
      "dropped.txt",
      "kept.txt",
    ]);
  });
});
