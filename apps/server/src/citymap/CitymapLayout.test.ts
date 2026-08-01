import { assert, describe, it } from "@effect/vitest";

import { buildCitymap, extensionOf, langForPath } from "./CitymapLayout.ts";
import type { InspectedFile } from "./CitymapLayout.ts";

const file = (path: string, lines: number, bytes = lines * 12): InspectedFile => ({
  path,
  dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  lines,
  bytes,
  lang: langForPath(path),
});

const build = (files: ReadonlyArray<InspectedFile>, ghostPaths?: ReadonlyArray<string>) =>
  buildCitymap({
    root: "/repo",
    commit: "abc1234",
    dirty: false,
    generatedAt: "1970-01-01T00:00:00Z",
    files,
    ...(ghostPaths ? { ghostPaths } : {}),
  });

describe("langForPath", () => {
  it("maps known extensions and falls through to the raw extension", () => {
    assert.equal(langForPath("src/main.go"), "go");
    assert.equal(langForPath("src/App.tsx"), "typescript");
    assert.equal(langForPath("docs/readme.MD"), "markdown");
    assert.equal(langForPath("conf/app.yml"), "yaml");
    assert.equal(langForPath("scripts/build.sh"), "sh");
  });

  it("treats an extensionless file as text, and a dotfile as all extension", () => {
    assert.equal(langForPath("Makefile"), "text");
    assert.equal(extensionOf(".gitignore"), ".gitignore");
    assert.equal(langForPath(".gitignore"), "gitignore");
  });
});

describe("buildCitymap", () => {
  it("is deterministic and gives every file a non-empty rect", () => {
    const files = [file("src/main.go", 2), file("README.md", 1)];
    const first = build(files);
    const second = build(files);

    assert.deepEqual(first, second);
    assert.equal(first.files.length, 2);
    assert.isAbove(first.files[0]!.rect.w, 0);
    assert.isAbove(first.files[0]!.rect.d, 0);
  });

  it("sorts files by path and assigns ids in that order", () => {
    const city = build([file("z.go", 5), file("a.go", 5), file("m/b.go", 5)]);

    assert.deepEqual(
      city.files.map((entry) => entry.path),
      ["a.go", "m/b.go", "z.go"],
    );
    assert.deepEqual(
      city.files.map((entry) => entry.id),
      [0, 1, 2],
    );
  });

  it("emits a plate per directory carrying its recursive file count and lines", () => {
    const city = build([
      file("pkg/a/one.go", 10),
      file("pkg/a/two.go", 20),
      file("pkg/b/three.go", 30),
    ]);

    const pkg = city.dirs.find((dir) => dir.path === "pkg");
    const pkgA = city.dirs.find((dir) => dir.path === "pkg/a");
    assert.deepEqual(
      { fileCount: pkg?.fileCount, lines: pkg?.lines, depth: pkg?.depth },
      { fileCount: 3, lines: 60, depth: 1 },
    );
    assert.deepEqual(
      { fileCount: pkgA?.fileCount, lines: pkgA?.lines, depth: pkgA?.depth },
      { fileCount: 2, lines: 30, depth: 2 },
    );
  });

  it("keeps aspect ratios sane across a wide flat directory", () => {
    const files = Array.from({ length: 80 }, (_, index) =>
      file(`pkg/file-${String(index).padStart(2, "0")}.go`, 2),
    );

    const worstRatio = build(files).files.reduce((worst, entry) => {
      assert.isAbove(entry.rect.w, 0);
      assert.isAbove(entry.rect.d, 0);
      return Math.max(worst, entry.rect.w / entry.rect.d, entry.rect.d / entry.rect.w);
    }, 0);

    assert.isBelow(worstRatio, 25);
  });

  it("stays inside the 120x120 world", () => {
    const city = build([file("a.go", 1000), file("deep/nested/b.go", 3), file("c.md", 40)]);

    for (const entry of [...city.files, ...city.dirs]) {
      assert.isAtLeast(entry.rect.x, 0);
      assert.isAtLeast(entry.rect.z, 0);
      assert.isAtMost(entry.rect.x + entry.rect.w, 120);
      assert.isAtMost(entry.rect.z + entry.rect.d, 120);
    }
  });

  it("sizes a byte-heavy file above a line-light one, and floors tiny files", () => {
    const city = build([file("minified.js", 1, 4_096_000), file("tiny.js", 1, 4)]);

    const minified = city.files.find((entry) => entry.path === "minified.js")!;
    const tiny = city.files.find((entry) => entry.path === "tiny.js")!;
    assert.isAbove(minified.rect.w * minified.rect.d, tiny.rect.w * tiny.rect.d);
    assert.isAbove(tiny.rect.w * tiny.rect.d, 0);
  });

  it("raises ghost buildings for paths no longer on disk, and skips duplicates", () => {
    const city = build([file("tracked.go", 4)], ["deleted.go", "tracked.go", ""]);

    const ghosts = city.files.filter((entry) => entry.ghost);
    assert.deepEqual(
      ghosts.map((entry) => entry.path),
      ["deleted.go"],
    );
    assert.deepEqual(
      { lines: ghosts[0]!.lines, bytes: ghosts[0]!.bytes, lang: ghosts[0]!.lang },
      { lines: 0, bytes: 0, lang: "go" },
    );
    assert.equal(city.files.filter((entry) => entry.path === "tracked.go").length, 1);
  });

  it("omits commit when the repository has no HEAD", () => {
    const city = buildCitymap({
      root: "/repo",
      commit: null,
      dirty: true,
      generatedAt: "1970-01-01T00:00:00Z",
      files: [file("a.go", 1)],
    });

    assert.isUndefined(city.repo.commit);
    assert.isTrue(city.repo.dirty);
    assert.equal(city.layout.algorithm, "squarified-treemap-v1");
  });
});
