/**
 * The order the snapshot is assembled in — trace with paths only, citymap with
 * those paths as ghosts, backfill the ids, recount the stats — copied from
 * mindwalk's `server.go:834-841`. Getting it wrong is invisible until a
 * building fails to light, so each step is pinned here.
 */
import { assert, describe, it } from "@effect/vitest";
import type { Citymap, Trace } from "@t3tools/contracts";

import { finalizeTrace, ghostPathsOf, withGhosts } from "./MindwalkSnapshot.ts";
import { buildCitymap, langForPath } from "../citymap/CitymapLayout.ts";
import { buildTrace, parseLens, type TraceActivityRow } from "./TraceProjection.ts";

const claudeTool = (toolName: string, input: Record<string, unknown>): TraceActivityRow => ({
  kind: "tool.completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    itemType: "command_execution",
    data: { toolName, input, result: { content: "", is_error: false } },
  },
});

const trace = (activities: ReadonlyArray<TraceActivityRow>): Trace =>
  buildTrace({
    threadId: "thread-1",
    providerName: "claudeAgent",
    root: "/repo",
    activities,
    messages: [],
    lens: parseLens(undefined),
    repoPathExists: () => true,
  });

const citymap = (paths: ReadonlyArray<string>): Citymap =>
  buildCitymap({
    root: "/repo",
    commit: "abc1234",
    dirty: false,
    generatedAt: "1970-01-01T00:00:00Z",
    files: paths.map((path) => ({
      path,
      dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      lines: 10,
      bytes: 120,
      lang: langForPath(path),
    })),
  });

describe("ghostPathsOf", () => {
  it("takes typed targets and refuses guessed ones", () => {
    const built = trace([
      claudeTool("Edit", { file_path: "/repo/src/a.ts" }),
      // Scraped out of a shell string, so it must not conjure a building.
      claudeTool("Bash", { command: "cat src/guessed.ts" }),
    ]);
    assert.deepEqual(ghostPathsOf(built), ["src/a.ts"]);
  });

  it("names each path once, however many events touched it", () => {
    const built = trace([
      claudeTool("Read", { file_path: "/repo/src/a.ts" }),
      claudeTool("Edit", { file_path: "/repo/src/a.ts" }),
    ]);
    assert.deepEqual(ghostPathsOf(built), ["src/a.ts"]);
  });
});

describe("withGhosts", () => {
  it("raises a building for a file the repository no longer has", () => {
    const withGhost = withGhosts(citymap(["src/a.ts"]), ["src/deleted.ts"]);
    const ghost = withGhost.files.find((file) => file.path === "src/deleted.ts");
    assert.isDefined(ghost);
    assert.isTrue(ghost?.ghost);
    assert.equal(ghost?.lines, 0);
    // The real file keeps its measurements and stays solid.
    const real = withGhost.files.find((file) => file.path === "src/a.ts");
    assert.equal(real?.lines, 10);
    assert.isFalse(real?.ghost);
  });

  it("leaves a path the repository still has alone", () => {
    const base = citymap(["src/a.ts"]);
    const withGhost = withGhosts(base, ["src/a.ts"]);
    assert.equal(withGhost.files.length, 1);
    assert.isFalse(withGhost.files[0]?.ghost);
  });

  it("returns the cached citymap untouched when the trace raised no ghosts", () => {
    const base = citymap(["src/a.ts"]);
    assert.strictEqual(withGhosts(base, []), base);
  });

  it("keeps the repository metadata of the map it re-laid", () => {
    const withGhost = withGhosts(citymap(["src/a.ts"]), ["src/deleted.ts"]);
    assert.deepEqual(withGhost.repo, {
      root: "/repo",
      commit: "abc1234",
      dirty: false,
      generatedAt: "1970-01-01T00:00:00Z",
    });
  });
});

describe("finalizeTrace", () => {
  it("backfills each target's fileId from the citymap", () => {
    const built = trace([claudeTool("Edit", { file_path: "/repo/src/a.ts" })]);
    const city = withGhosts(citymap(["README.md", "src/a.ts"]), ghostPathsOf(built));
    const expected = city.files.find((file) => file.path === "src/a.ts")?.id;

    const final = finalizeTrace(built, city);
    assert.equal(final.events[0]?.targets[0]?.fileId, expected);
  });

  it("leaves fileId off a target with no building, rather than pointing it at zero", () => {
    const built = trace([claudeTool("Bash", { command: "cat src/guessed.ts" })]);
    // The guessed path is weak, so it raised no ghost and has nowhere to land.
    const final = finalizeTrace(built, citymap(["README.md"]));
    assert.deepEqual(final.events[0]?.targets, [
      { path: "src/guessed.ts", touch: "read", weak: true },
    ]);
  });

  it("recounts filesInRepo without the ghosts, and keeps the adapter's error grade", () => {
    const built = trace([claudeTool("Edit", { file_path: "/repo/src/deleted.ts" })]);
    const city = withGhosts(citymap(["README.md", "src/a.ts"]), ghostPathsOf(built));
    assert.equal(city.files.length, 3);

    const final = finalizeTrace(built, city);
    // A ghost is not a file in the repository.
    assert.equal(final.stats.filesInRepo, 2);
    assert.equal(final.stats.observability.errors, "exact");
    assert.equal(final.stats.edited, 1);
  });

  it("counts nothing in the repository when the citymap build failed", () => {
    const built = trace([claudeTool("Edit", { file_path: "/repo/src/a.ts" })]);
    const empty: Citymap = {
      version: 1,
      repo: { root: "/repo", dirty: false, generatedAt: "1970-01-01T00:00:00Z" },
      files: [],
      dirs: [],
      layout: { algorithm: "unavailable", weight: "none" },
    };

    // The timeline still plays; it just has no buildings to land on.
    const final = finalizeTrace(built, empty);
    assert.equal(final.stats.filesInRepo, 0);
    assert.equal(final.events.length, 1);
    assert.isUndefined(final.events[0]?.targets[0]?.fileId);
  });
});
