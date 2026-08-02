/**
 * The service against a real git repository, because every decision it makes
 * is a decision about what git prints: which commits a merge contributes, what
 * "uncommitted" includes, and when the branch-range window gives way to the
 * recent-commits fallback. A mocked driver would only pin the fixtures.
 *
 * Each commit step is checked against an independently spelled
 * `git show --numstat` — line-oriented, not the `-z` grammar the service
 * parses — so a mistake in that grammar cannot agree with itself.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CitymapBuilder from "../citymap/CitymapBuilder.ts";
import * as ServerConfig from "../config.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as DiffOverlay from "./DiffOverlay.ts";

/**
 * `ServerConfig` is what bounds the cwd a diff may be taken in, so the layer
 * has to be rooted at the repository under test.
 */
const layerFor = (root: string) =>
  Layer.mergeAll(DiffOverlay.layer, GitVcsDriver.layer, GitVcsDriver.vcsLayer).pipe(
    Layer.provideMerge(ReviewService.layer),
    Layer.provideMerge(CitymapBuilder.layer),
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3-diff-overlay-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const git = Effect.fn("git")(function* (root: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "DiffOverlayService.test.git",
    cwd: root,
    args,
    allowNonZeroExit: true,
    timeoutMs: 30_000,
  });
  return result.stdout;
});

/** A deliberately different parser from the service's: lines, not NUL fields. */
const parsePlainNumstat = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [additions, deletions, ...rest] = line.split("\t");
      const count = (value: string | undefined) =>
        value === undefined || value === "-" ? 0 : Number.parseInt(value, 10);
      return { path: rest.join("\t"), additions: count(additions), deletions: count(deletions) };
    });

const byPath = <A extends { path: string }>(files: ReadonlyArray<A>) =>
  [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

/**
 * A repository with every commit shape the log grammar has to survive: a merge
 * (which `git log` shows nothing for by default), a commit that changed
 * nothing, one with no message at all, and a binary file with no lines to
 * count. Plus a deletion, and staged, unstaged and untracked changes at once.
 */
const makeRepo = Effect.fn("makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-diff-overlay-repo-" });
  const write = (name: string, contents: string) =>
    fileSystem.writeFileString(path.join(root, name), contents);
  const run = (args: ReadonlyArray<string>) => git(root, args).pipe(Effect.provide(layerFor(root)));

  yield* run(["init", "-b", "main", "."]);
  yield* run(["config", "user.email", "test@example.com"]);
  yield* run(["config", "user.name", "Test"]);
  yield* write("a.txt", "one\ntwo\n");
  yield* write("gone.txt", "x\n");
  yield* run(["add", "-A"]);
  yield* run(["commit", "-m", "first"]);

  yield* run(["checkout", "-b", "side"]);
  yield* write("side.txt", "s1\ns2\ns3\n");
  yield* run(["add", "-A"]);
  yield* run(["commit", "-m", "side work"]);
  yield* run(["checkout", "main"]);
  yield* write("a.txt", "one\ntwo\nthree\n");
  yield* run(["add", "-A"]);
  yield* run(["commit", "-m", "main work"]);
  yield* run(["merge", "--no-ff", "-m", "merge side", "side"]);

  yield* run(["rm", "gone.txt"]);
  yield* run(["commit", "-m", "drop gone"]);
  yield* run(["commit", "--allow-empty", "-m", "changed nothing"]);
  yield* run(["commit", "--allow-empty", "--allow-empty-message", "-m", ""]);
  yield* fileSystem.writeFile(path.join(root, "bin.dat"), new Uint8Array([0, 1, 2, 3, 0, 255]));
  yield* run(["add", "-A"]);
  yield* run(["commit", "-m", "add a binary"]);

  yield* write("a.txt", "one\ntwo\nthree\nstaged\n");
  yield* run(["add", "a.txt"]);
  yield* write("a.txt", "one\ntwo\nthree\nstaged\nunstaged\n");
  yield* write("untracked.txt", "u1\nu2\n");

  return root;
});

describe("DiffOverlayService", () => {
  it.effect("steps every commit, and agrees with git one commit at a time", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: root, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));

      const commits = overlay.steps;
      assert.deepEqual(
        commits.map((step) => step.title),
        ["first", "main work", "merge side", "drop gone", "changed nothing", "", "add a binary"],
        "oldest to newest, with the side branch folded into its merge",
      );

      for (const step of commits) {
        const expected = parsePlainNumstat(
          yield* git(root, [
            "show",
            "--numstat",
            "--no-renames",
            "--first-parent",
            "--diff-merges=first-parent",
            "--format=",
            step.id,
          ]).pipe(Effect.provide(layerFor(root))),
        );
        assert.deepEqual(byPath(step.files), byPath(expected), `commit ${step.title}`);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives a merge the churn it brought in, and an empty commit no files", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: root, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));
      const step = (title: string) => overlay.steps.find((entry) => entry.title === title);

      // `git log` shows no diff for a merge by default, which would render the
      // merged branch's work as a step that changed nothing.
      assert.deepEqual(step("merge side")?.files, [
        { path: "side.txt", additions: 3, deletions: 0 },
      ]);
      assert.deepEqual(step("changed nothing")?.files, []);
      // A binary has no lines, so it gets a building and no height.
      assert.deepEqual(step("add a binary")?.files, [
        { path: "bin.dat", additions: 0, deletions: 0 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to recent commits when the branch has not diverged", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: root, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));

      // No remote and no other branch to diff against, which is the shape of
      // committing straight to the default branch.
      assert.deepEqual(overlay.range, {
        kind: "recent-commits",
        baseRef: null,
        headRef: null,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("raises a ghost for a file the range deleted", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: root, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));

      assert.deepEqual(
        overlay.citymap.files.filter((file) => file.ghost).map((file) => file.path),
        ["gone.txt"],
      );
      // Nothing a step touched may be left without a building to draw on.
      const inMap = new Set(overlay.citymap.files.map((file) => file.path));
      const touched = new Set(overlay.steps.flatMap((step) => step.files.map((file) => file.path)));
      assert.deepEqual(
        [...touched].filter((path) => !inMap.has(path)),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serves a citymap and an empty scrubber outside a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-diff-overlay-bare-" });
      yield* fileSystem.writeFileString(path.join(root, "notes.md"), "hello\n");

      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: root, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));

      assert.deepEqual(overlay.range, { kind: "working-tree", baseRef: null, headRef: null });
      assert.deepEqual(overlay.steps, []);
      assert.deepEqual(
        overlay.citymap.files.map((file) => file.path),
        ["notes.md"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // `git log --numstat` reports root-relative paths wherever it runs, but the
  // citymap walks the directory it is given — so a subdirectory cwd would pair
  // whole-repo steps against a fragment of a city and every column would miss
  // its building.
  it.effect("resolves a subdirectory cwd to the repository root", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = path.join(root, "nested");
      yield* fileSystem.makeDirectory(nested);
      yield* fileSystem.writeFileString(path.join(nested, "deep.txt"), "one\n");

      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: nested, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));

      assert.strictEqual(overlay.cwd, root);
      // A file outside the requested subdirectory still has a building, which
      // is the whole point: the steps name it, so the city must contain it.
      assert.include(
        overlay.citymap.files.map((file) => file.path),
        "a.txt",
      );
      assert.deepEqual(
        overlay.steps.map((step) => step.title),
        ["first", "main work", "merge side", "drop gone", "changed nothing", "", "add a binary"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The 2D Diff panel sends the user's `diffIgnoreWhitespace` on every request
  // and it defaults to on, so a 3D surface that never asked would report a
  // reformat as a tower while the panel beside it reported nothing.
  it.effect("honours ignoreWhitespace, on the log and the working tree alike", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const run = (args: ReadonlyArray<string>) =>
        git(root, args).pipe(Effect.provide(layerFor(root)));

      // one commit that only re-indents, and the same in the working tree
      yield* fileSystem.writeFileString(path.join(root, "ws.txt"), "a\nb\n");
      yield* run(["add", "-A"]);
      yield* run(["commit", "-m", "add ws"]);
      yield* fileSystem.writeFileString(path.join(root, "ws.txt"), "    a\n    b\n");
      yield* run(["add", "-A"]);
      yield* run(["commit", "-m", "reindent"]);
      yield* fileSystem.writeFileString(path.join(root, "ws.txt"), "        a\n        b\n");

      const overlayFor = (ignoreWhitespace: boolean) =>
        Effect.gen(function* () {
          const service = yield* DiffOverlay.DiffOverlayService;
          return yield* service.getOverlay({ cwd: root, ignoreWhitespace });
        }).pipe(Effect.provide(layerFor(root)));

      const counted = yield* overlayFor(false);
      const ignored = yield* overlayFor(true);
      const filesOf = (overlay: typeof counted, title: string) =>
        overlay.steps.find((step) => step.title === title)?.files ?? [];

      assert.isNotEmpty(filesOf(counted, "reindent"), "counted: the commit re-indents two lines");
      assert.deepEqual(filesOf(ignored, "reindent"), [], "ignored: nothing but whitespace moved");

      // The working tree's own answer to the same setting is the review
      // preview's now, and `GitVcsDriverCore` carries the test for it.
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The cwd is the client's, and the two failures above both degrade rather
  // than fail — so the boundary has to be its own answer, or "not a repo" and
  // "not yours to read" become the same benign outcome and the overlay hands
  // back a citymap of whatever path was asked for.
  it.effect("refuses a cwd outside the configured workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-diff-overlay-ws-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-diff-overlay-outside-",
      });
      yield* fileSystem.writeFileString(path.join(outside, "private.md"), "hello\n");

      const error = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service
          .getOverlay({ cwd: outside, ignoreWhitespace: false })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layerFor(workspace)));

      assert.strictEqual(error._tag, "DiffOverlayOutsideWorkspaceError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Those uncommitted changes still need somewhere to stand when the
  // working-tree scope draws them, and a deleted file is in no commit step.
  it.effect("ghosts a file deleted without being committed", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const run = (args: ReadonlyArray<string>) =>
        git(root, args).pipe(Effect.provide(layerFor(root)));
      // A clean file: `makeRepo` leaves `a.txt` modified, and `git rm` refuses
      // to remove a file with local changes.
      yield* run(["rm", "side.txt"]);

      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay({ cwd: root, ignoreWhitespace: false });
      }).pipe(Effect.provide(layerFor(root)));

      const ghosts = overlay.citymap.files.filter((file) => file.ghost).map((file) => file.path);
      assert.include(ghosts, "side.txt");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
