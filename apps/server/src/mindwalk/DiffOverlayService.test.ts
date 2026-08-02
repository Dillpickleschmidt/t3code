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
        return yield* service.getOverlay(root);
      }).pipe(Effect.provide(layerFor(root)));

      const commits = overlay.steps.filter((step) => step.kind === "commit");
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
        return yield* service.getOverlay(root);
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

  it.effect("ends on everything uncommitted: staged, unstaged and untracked", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay(root);
      }).pipe(Effect.provide(layerFor(root)));

      const last = overlay.steps.at(-1);
      assert.strictEqual(last?.kind, "working-tree");
      assert.deepEqual(byPath(last?.files ?? []), [
        // Both the staged line and the unstaged one, because the 2D panel's
        // working-tree source diffs against HEAD rather than against the index.
        { path: "a.txt", additions: 2, deletions: 0 },
        { path: "untracked.txt", additions: 2, deletions: 0 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to recent commits when the branch has not diverged", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      const overlay = yield* Effect.gen(function* () {
        const service = yield* DiffOverlay.DiffOverlayService;
        return yield* service.getOverlay(root);
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
        return yield* service.getOverlay(root);
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
        return yield* service.getOverlay(root);
      }).pipe(Effect.provide(layerFor(root)));

      assert.deepEqual(overlay.range, { kind: "working-tree", baseRef: null, headRef: null });
      assert.deepEqual(overlay.steps, []);
      assert.deepEqual(
        overlay.citymap.files.map((file) => file.path),
        ["notes.md"],
      );
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
        return yield* service.getOverlay(outside).pipe(Effect.flip);
      }).pipe(Effect.provide(layerFor(workspace)));

      assert.strictEqual(error._tag, "DiffOverlayError");
      assert.strictEqual(error.operation, "outsideWorkspace");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
