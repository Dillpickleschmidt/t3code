import { assert, describe, it } from "@effect/vitest";

import { buildCitymap, compareUtf8, extensionOf, langForPath } from "./CitymapLayout.ts";
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
  // The golden fixture in CitymapBuilder.test.ts pins the common cases end to
  // end; these are the ones it does not reach — aliasing, case folding, and
  // the fallthrough to a raw extension.
  it("maps known extensions and falls through to the raw extension", () => {
    assert.equal(langForPath("src/main.go"), "go");
    assert.equal(langForPath("src/App.tsx"), "typescript");
    assert.equal(langForPath("docs/readme.MD"), "markdown");
    assert.equal(langForPath("conf/app.yml"), "yaml");
    assert.equal(langForPath("scripts/build.sh"), "sh");
    // A dotfile is all extension, with no basename to fall back on.
    assert.equal(extensionOf(".gitignore"), ".gitignore");
  });
});

describe("compareUtf8", () => {
  it("orders supplementary-plane characters after U+E000, as Go does", () => {
    const astral = "\u{10000}";
    const privateUse = "";

    // JavaScript's `<` puts the surrogate pair first; UTF-8 bytes do not, and
    // the reference layout sorts by bytes.
    assert.isTrue(astral < privateUse);
    assert.isAbove(compareUtf8(astral, privateUse), 0);
    assert.isBelow(compareUtf8(privateUse, astral), 0);
    assert.equal(compareUtf8(astral, astral), 0);
    // The all-BMP fast path must still agree with plain comparison.
    assert.isBelow(compareUtf8("a.go", "b.go"), 0);
    assert.isBelow(compareUtf8("pkg/a.go", "pkg/a.go.bak"), 0);
  });
});

describe("buildCitymap", () => {
  // 80 siblings push the squarify and aspect-cap paths far past anything the
  // 13-file golden reaches, so this checks the rect invariants at scale.
  it("keeps every rect inside the world and reasonably square at scale", () => {
    const files = Array.from({ length: 80 }, (_, index) =>
      file(`pkg/file-${String(index).padStart(2, "0")}.go`, 2),
    );
    const city = build(files);

    let worstRatio = 0;
    for (const entry of [...city.files, ...city.dirs]) {
      assert.isAbove(entry.rect.w, 0);
      assert.isAbove(entry.rect.d, 0);
      assert.isAtLeast(entry.rect.x, 0);
      assert.isAtLeast(entry.rect.z, 0);
      assert.isAtMost(entry.rect.x + entry.rect.w, 120);
      assert.isAtMost(entry.rect.z + entry.rect.d, 120);
      worstRatio = Math.max(worstRatio, entry.rect.w / entry.rect.d, entry.rect.d / entry.rect.w);
    }

    assert.isBelow(worstRatio, 25);
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
