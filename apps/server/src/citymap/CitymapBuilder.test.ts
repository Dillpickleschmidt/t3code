import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CitymapBuilder from "./CitymapBuilder.ts";
import goldenCitymap from "./__fixtures__/mindwalk-citymap.golden.json" with { type: "json" };
import goldenTree from "./__fixtures__/tree.json" with { type: "json" };

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-citymap-" });

const CitymapTestLayer = Layer.mergeAll(
  CitymapBuilder.layer,
  GitVcsDriver.layer,
  GitVcsDriver.vcsLayer,
).pipe(
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = Effect.fn("runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  yield* driver.execute({ operation: "CitymapBuilder.test.git", cwd, args, timeoutMs: 10_000 });
});

const writeFile = Effect.fn("writeFile")(function* (
  root: string,
  relativePath: string,
  contents: string | Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(root, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolute), { recursive: true });
  yield* typeof contents === "string"
    ? fileSystem.writeFileString(absolute, contents)
    : fileSystem.writeFile(absolute, contents);
});

/**
 * A fixture tree and the citymap the real mindwalk binary produces for it,
 * captured from `GET /api/repomap` at the pinned `v0.3.0`. Regenerate both
 * together if the tree changes; `repo` is stripped because it records where
 * and when the capture ran.
 */
const fixtureTree: Record<string, { text?: string; repeat?: number; base64?: string }> = goldenTree;

const materializeFixtureTree = Effect.fn("materializeFixtureTree")(function* (root: string) {
  for (const [relativePath, spec] of Object.entries(fixtureTree)) {
    const contents =
      spec.base64 !== undefined
        ? Uint8Array.from(Buffer.from(spec.base64, "base64"))
        : spec.repeat
          ? spec.text!.repeat(spec.repeat)
          : spec.text!;
    yield* writeFile(root, relativePath, contents);
  }
});

const makeRepo = Effect.fn("makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-citymap-repo-" });
  yield* runGit(root, ["init"]);
  yield* runGit(root, ["config", "user.email", "test@test.com"]);
  yield* runGit(root, ["config", "user.name", "Test"]);
  return root;
});

it.layer(CitymapTestLayer)("CitymapBuilder", (it) => {
  it.effect("includes tracked and untracked files, counting lines per file", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* writeFile(root, "tracked.go", "package main\n");
      yield* runGit(root, ["add", "tracked.go"]);
      yield* runGit(root, ["commit", "-m", "first"]);
      // No trailing newline: the partial last line still counts.
      yield* writeFile(root, "src/new.go", "package main\nfunc New() {}");

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      const byPath = new Map(city.files.map((file) => [file.path, file]));
      assert.deepEqual([...byPath.keys()].sort(), ["src/new.go", "tracked.go"]);
      assert.equal(byPath.get("tracked.go")!.lines, 1);
      assert.equal(byPath.get("tracked.go")!.dir, "");
      assert.equal(byPath.get("src/new.go")!.lines, 2);
      assert.equal(byPath.get("src/new.go")!.dir, "src");
      assert.equal(byPath.get("src/new.go")!.lang, "go");
    }),
  );

  it.effect("excludes gitignored files and records the repository state", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* writeFile(root, ".gitignore", "ignored/\n");
      yield* writeFile(root, "ignored/secret.txt", "shhh\n");
      yield* writeFile(root, "kept.txt", "hello\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "first"]);

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      assert.deepEqual(city.files.map((file) => file.path).sort(), [".gitignore", "kept.txt"]);
      assert.isDefined(city.repo.commit);
      assert.isFalse(city.repo.dirty);
    }),
  );

  it.effect("reports a dirty worktree", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* writeFile(root, "a.txt", "one\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "first"]);
      yield* writeFile(root, "a.txt", "one\ntwo\n");

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      assert.isTrue(city.repo.dirty);
    }),
  );

  it.effect("counts a binary file as a single line but sizes it by bytes", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      // A NUL byte in the head marks it binary even though .bin is not a known
      // binary extension.
      yield* writeFile(root, "blob.bin", new Uint8Array([0x61, 0x00, 0x0a, 0x0a, 0x0a]));
      yield* runGit(root, ["add", "."]);

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      const blob = city.files.find((file) => file.path === "blob.bin")!;
      assert.equal(blob.lines, 1);
      assert.equal(blob.bytes, 5);
    }),
  );

  it.effect("serves a clean tree from cache instead of rewalking", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* writeFile(root, "a.txt", "one\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "first"]);

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const first = yield* builder.buildForRoot(root);

      // Written but never staged, so `git status` still reports clean only
      // because .gitignore hides it — the cache must return the old map.
      yield* writeFile(root, ".gitignore", "later.txt\n");
      yield* runGit(root, ["add", ".gitignore"]);
      yield* runGit(root, ["commit", "-m", "ignore"]);
      yield* writeFile(root, "later.txt", "two\n");

      const second = yield* builder.buildForRoot(root);
      assert.notDeepEqual(
        second.files.map((file) => file.path),
        first.files.map((file) => file.path),
      );

      const third = yield* builder.buildForRoot(root);
      assert.strictEqual(third, second);
    }),
  );

  it.effect("matches the real mindwalk binary byte for byte on a fixture tree", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* materializeFixtureTree(root);
      yield* runGit(root, ["add", "-A"]);
      yield* runGit(root, ["commit", "-m", "fixture"]);

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      // `repo` records the absolute root, HEAD, and build time, none of which
      // survive a move between machines. Everything else — ids, ordering,
      // line counts, langs, and every treemap rect — must match exactly.
      const { repo: _repo, ...actual } = city;
      assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), goldenCitymap);
    }),
  );

  it.effect("collapses concurrent builds of one root into a single walk", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* writeFile(root, "a.txt", "one\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "first"]);

      const builder = yield* CitymapBuilder.CitymapBuilder;
      // Both start before either finishes, so the cache is empty for both.
      // Identical references can then only mean the second joined the first
      // rather than walking the tree again.
      const [first, second, third] = yield* Effect.all(
        [builder.buildForRoot(root), builder.buildForRoot(root), builder.buildForRoot(root)],
        { concurrency: "unbounded" },
      );

      assert.strictEqual(second, first);
      assert.strictEqual(third, first);
    }),
  );

  it.effect("skips a symlink to a special file rather than reading it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-citymap-device-" });
      yield* writeFile(root, "real.txt", "ordinary\n");
      // A character device stands in for the dangerous case: a symlinked FIFO
      // would block the read loop forever, and every caller joining that
      // in-flight build with it.
      yield* fileSystem.symlink("/dev/null", path.join(root, "device"));

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      assert.deepEqual(
        city.files.map((entry) => entry.path),
        ["real.txt"],
      );
    }),
  );

  it.effect("does not follow a symlinked directory out of the walked root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-citymap-outside-" });
      yield* writeFile(outside, "secret.txt", "not part of the repo\n");

      // Not a git repo, so the fallback walk runs. Go's WalkDir uses lstat
      // semantics and never descends a symlink; neither should we, or the
      // citymap would expose paths the endpoint was never scoped to.
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-citymap-symlink-" });
      yield* writeFile(root, "inside.txt", "mine\n");
      yield* fileSystem.symlink(outside, path.join(root, "escape"));

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      assert.deepEqual(
        city.files.map((entry) => entry.path),
        ["inside.txt"],
      );
    }),
  );

  it.effect("falls back to walking a directory that is not a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-citymap-plain-" });
      yield* writeFile(root, "a.txt", "one\ntwo\n");
      yield* writeFile(root, "nested/b.txt", "three\n");
      yield* writeFile(root, "node_modules/dep/index.js", "module.exports = {}\n");

      const builder = yield* CitymapBuilder.CitymapBuilder;
      const city = yield* builder.buildForRoot(root);

      assert.deepEqual(city.files.map((file) => file.path).sort(), ["a.txt", "nested/b.txt"]);
      assert.isUndefined(city.repo.commit);
      assert.isFalse(city.repo.dirty);
    }),
  );
});
