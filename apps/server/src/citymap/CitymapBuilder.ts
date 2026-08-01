/**
 * CitymapBuilder - walks a repository and lays it out as a citymap.
 *
 * A port of mindwalk's `internal/citymap/builder.go` filesystem half (MIT,
 * © 2026 Ricko Yu); the treemap itself lives in `CitymapLayout.ts`.
 *
 * The expensive part is the walk — every non-binary file is read end to end to
 * count its lines — so results are cached per root, keyed on the repository's
 * commit and dirty state the way mindwalk keys its fingerprint cache. A dirty
 * tree cannot be keyed precisely (the same "dirty" covers every edit), so dirty
 * entries also carry a short TTL, mirroring mindwalk's `repoMapTTL`.
 *
 * @module CitymapBuilder
 */
import type { Citymap } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import { buildCitymap, dirForPath, extensionOf, langForPath } from "./CitymapLayout.ts";
import type { InspectedFile } from "./CitymapLayout.ts";

/** Extensions treated as binary without reading the file. */
const BINARY_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".zip",
  ".gz",
  ".tgz",
  ".mp4",
  ".mov",
  ".mp3",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);
/** Directories the non-git fallback walk refuses to descend into. */
const FALLBACK_WALK_SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "dist", "build"]);
/** Guard against symlink cycles; Effect's FileSystem has no lstat to spot them. */
const FALLBACK_WALK_MAX_DEPTH = 64;
/** Read buffer for line counting, matching mindwalk's 64 KiB chunks. */
const READ_CHUNK_BYTES = 64 * 1024;
/** Bytes of a file's head scanned for a NUL byte before trusting it as text. */
const BINARY_SNIFF_BYTES = 8192;
/** Files inspected at once. The walk is IO-bound and runs once per commit. */
const INSPECT_CONCURRENCY = 32;
/** How long a citymap built from a dirty tree stays valid. */
const DIRTY_CACHE_TTL_MS = 30_000;
/**
 * Roots kept in the cache, oldest evicted first. Matches mindwalk's
 * `repoMapMaxEntries`. A citymap of this repo — 15.7k files, 1.7k dirs, the
 * largest tree we expect — measures ~3.5 MB on the heap, so a full cache is
 * ~57 MB in the worst case and far less for ordinary repositories.
 */
const CACHE_MAX_ENTRIES = 16;

export class CitymapBuildError extends Schema.TaggedErrorClass<CitymapBuildError>()(
  "CitymapBuildError",
  {
    root: Schema.String,
    operation: Schema.Literals([
      "listWorkspaceFiles",
      "listWorkspaceFilesTruncated",
      "readDirectory",
      "stat",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Citymap build failed during "${this.operation}" for ${this.root}.`;
  }
}

export class CitymapBuilder extends Context.Service<
  CitymapBuilder,
  {
    /**
     * Build (or serve from cache) the citymap for a repository root. The result
     * depends only on the repository, never on a thread or a trace.
     */
    readonly buildForRoot: (root: string) => Effect.Effect<Citymap, CitymapBuildError>;
  }
>()("t3/citymap/CitymapBuilder") {}

interface CacheEntry {
  readonly key: string;
  readonly builtAt: number;
  readonly citymap: Citymap;
}

interface RepoState {
  readonly commit: string | null;
  readonly dirty: boolean;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const cache = new Map<string, CacheEntry>();
  /**
   * Builds currently running, by root. mindwalk holds `repoMapMu` across its
   * whole build so a second caller waits rather than walking the tree twice;
   * this does the same per root instead of globally, because one project's
   * walk must not block another's on a server that hosts many.
   */
  const inFlight = new Map<string, Deferred.Deferred<Citymap, CitymapBuildError>>();

  const failBuild = (root: string, operation: CitymapBuildError["operation"]) => (cause: unknown) =>
    new CitymapBuildError({ root, operation, cause });

  /**
   * The tracked-and-untracked file list, exactly as mindwalk asks git for it.
   * Outside a repository we fall back to walking the directory, which is the
   * only path that can see a project that has not been `git init`ed yet.
   */
  const listFiles = Effect.fn("CitymapBuilder.listFiles")(function* (
    root: string,
    handle: VcsDriver.VcsDriver["Service"] | null,
  ) {
    if (handle) {
      const listed = yield* handle
        .listWorkspaceFiles(root)
        .pipe(Effect.mapError(failBuild(root, "listWorkspaceFiles")));
      // A truncated listing would silently yield a partial map of the
      // codebase, which is worse than no map at all when the whole point is
      // that every file has a fixed place. mindwalk reads git's output
      // uncapped and has no equivalent case.
      if (listed.truncated) {
        return yield* Effect.fail(
          new CitymapBuildError({
            root,
            operation: "listWorkspaceFilesTruncated",
            cause: new Error(
              `Workspace file listing for ${root} exceeded the driver's output cap.`,
            ),
          }),
        );
      }
      if (listed.paths.length > 0) {
        return listed.paths;
      }
    }
    return yield* fallbackWalk(root, root, 0);
  });

  const fallbackWalk = Effect.fn("CitymapBuilder.fallbackWalk")(function* (
    root: string,
    directory: string,
    depth: number,
  ): Effect.fn.Return<Array<string>, CitymapBuildError> {
    if (depth > FALLBACK_WALK_MAX_DEPTH) return [];
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.orElseSucceed(() => path.resolve(root)));
    // Go's WalkDir propagates walk errors rather than skipping the directory,
    // and an empty citymap is indistinguishable from an empty repository, so a
    // permission or IO failure must not be cached as a valid result.
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.mapError(failBuild(root, "readDirectory")));

    const collected: Array<string> = [];
    for (const entry of entries.sort()) {
      const absolute = path.join(directory, entry);
      // Go's WalkDir surfaces lstat failures rather than skipping the entry;
      // only the later inspect phase tolerates them (mindwalk's `continue` on
      // inspectFile error). Skipping here would cache a partial citymap.
      const info = yield* fileSystem.stat(absolute).pipe(Effect.mapError(failBuild(root, "stat")));
      if (info.type === "Directory") {
        if (FALLBACK_WALK_SKIP_DIRECTORIES.has(entry)) continue;
        // `stat` follows symlinks, so a link to a directory would otherwise be
        // descended and could collect paths outside the repository. Go's
        // WalkDir uses lstat semantics and never descends a symlink; match that
        // by confining traversal to the real root.
        const real = yield* fileSystem.realPath(absolute).pipe(Effect.orElseSucceed(() => null));
        if (real === null || (real !== realRoot && !real.startsWith(realRoot + path.sep))) continue;
        collected.push(...(yield* fallbackWalk(root, absolute, depth + 1)));
        continue;
      }
      collected.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
    return collected;
  });

  /**
   * Stat a file and count its lines. Binary files count as a single line, the
   * way mindwalk does, so a large asset still gets a building sized by bytes.
   */
  const inspectFile = Effect.fn("CitymapBuilder.inspectFile")(function* (
    root: string,
    relativePath: string,
  ) {
    const absolute = path.join(root, relativePath);
    const info = yield* fileSystem.stat(absolute);
    const knownBinary = BINARY_EXTENSIONS.has(extensionOf(relativePath).toLowerCase());
    const lines = knownBinary ? 1 : yield* countLines(absolute).pipe(Effect.orElseSucceed(() => 0));

    return {
      path: relativePath,
      dir: dirForPath(relativePath),
      lines,
      bytes: Number(info.size),
      lang: langForPath(relativePath),
    } satisfies InspectedFile;
  });

  /**
   * Count newlines, plus one for a trailing partial line. A NUL byte in the
   * head of the file means binary, which counts as one line instead.
   */
  const countLines = Effect.fn("CitymapBuilder.countLines")(function* (absolute: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(absolute);
        const buffer = new Uint8Array(READ_CHUNK_BYTES);
        let lines = 0;
        let read = 0;
        let hasBytes = false;
        let last = 0;

        while (true) {
          const size = Number(yield* file.read(buffer));
          if (size === 0) break;
          if (read < BINARY_SNIFF_BYTES) {
            const sniffEnd = Math.min(size, BINARY_SNIFF_BYTES - read);
            if (buffer.subarray(0, sniffEnd).includes(0)) return 1;
          }
          read += size;
          hasBytes = true;
          last = buffer[size - 1]!;
          for (let index = 0; index < size; index += 1) {
            if (buffer[index] === 0x0a) lines += 1;
          }
        }

        return hasBytes && last !== 0x0a ? lines + 1 : lines;
      }),
    );
  });

  /** mindwalk's `repoState`: short HEAD plus whether the worktree is dirty. */
  const readRepoState = Effect.fn("CitymapBuilder.readRepoState")(function* (
    root: string,
    handle: VcsDriverRegistry.VcsDriverHandle | null,
  ): Effect.fn.Return<RepoState> {
    if (!handle || handle.kind !== "git") return { commit: null, dirty: false };

    const runGit = (operation: string, args: ReadonlyArray<string>) =>
      handle.driver
        .execute({ operation, cwd: root, args, allowNonZeroExit: true, timeoutMs: 10_000 })
        .pipe(Effect.orElseSucceed(() => null));

    const head = yield* runGit("CitymapBuilder.repoState.head", ["rev-parse", "--short", "HEAD"]);
    const status = yield* runGit("CitymapBuilder.repoState.status", ["status", "--porcelain"]);

    return {
      commit: head && head.exitCode === 0 ? head.stdout.trim() || null : null,
      dirty: status !== null && status.exitCode === 0 && status.stdout.trim().length > 0,
    };
  });

  const buildForRoot: CitymapBuilder["Service"]["buildForRoot"] = Effect.fn(
    "CitymapBuilder.buildForRoot",
  )(function* (requestedRoot) {
    const root = path.resolve(requestedRoot);
    yield* Effect.annotateCurrentSpan({ "citymap.root": root });

    const handle = yield* registry.detect({ cwd: root }).pipe(Effect.orElseSucceed(() => null));
    const repoState = yield* readRepoState(root, handle);

    const cacheKey = `${repoState.commit ?? ""}:${repoState.dirty}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(root);
    // A clean git tree is pinned by its commit, so it can be cached until
    // evicted. A dirty tree cannot be keyed precisely, and a non-git root has
    // no fingerprint at all, so both fall back to the TTL.
    const pinnedByCommit = repoState.commit !== null && !repoState.dirty;
    if (
      cached &&
      cached.key === cacheKey &&
      (pinnedByCommit || now - cached.builtAt < DIRTY_CACHE_TTL_MS)
    ) {
      yield* Effect.annotateCurrentSpan({ "citymap.cache": "hit" });
      return cached.citymap;
    }

    // Join a build already running for this root instead of repeating it.
    // Claiming is synchronous — `makeUnsafe` and the `set` below leave no
    // yield point between the lookup and the claim — so two fibers arriving
    // together cannot both become the builder.
    // Keyed by root *and* state: a caller that observed a newer commit must
    // not be handed a citymap built for the older one.
    const flightKey = `${root}:${cacheKey}`;
    const running = inFlight.get(flightKey);
    if (running) {
      yield* Effect.annotateCurrentSpan({ "citymap.cache": "joined" });
      return yield* Deferred.await(running);
    }
    const deferred = Deferred.makeUnsafe<Citymap, CitymapBuildError>();
    inFlight.set(flightKey, deferred);

    return yield* Effect.gen(function* () {
      const relativePaths = yield* listFiles(root, handle?.driver ?? null);
      const inspected = yield* Effect.forEach(
        relativePaths,
        (relativePath) => inspectFile(root, relativePath).pipe(Effect.orElseSucceed(() => null)),
        { concurrency: INSPECT_CONCURRENCY },
      );

      const citymap = buildCitymap({
        root,
        commit: repoState.commit,
        dirty: repoState.dirty,
        generatedAt: DateTime.formatIso(yield* DateTime.now),
        files: inspected.filter((file): file is InspectedFile => file !== null),
      });

      cache.set(root, { key: cacheKey, builtAt: now, citymap });
      evictOldest();
      yield* Effect.annotateCurrentSpan({
        "citymap.cache": "miss",
        "citymap.file_count": citymap.files.length,
      });
      return citymap;
    }).pipe(
      // Hand the outcome to every joiner, including on failure or interrupt,
      // so a waiter can never outlive the build it is waiting on.
      Effect.onExit((exit) =>
        Deferred.done(deferred, exit).pipe(
          Effect.andThen(
            Effect.sync(() => {
              inFlight.delete(flightKey);
            }),
          ),
        ),
      ),
    );
  });

  function evictOldest() {
    while (cache.size > CACHE_MAX_ENTRIES) {
      let oldestRoot: string | null = null;
      let oldestAt = Infinity;
      for (const [root, entry] of cache) {
        if (entry.builtAt < oldestAt) {
          oldestAt = entry.builtAt;
          oldestRoot = root;
        }
      }
      if (oldestRoot === null) break;
      cache.delete(oldestRoot);
    }
  }

  return CitymapBuilder.of({ buildForRoot });
});

export const layer = Layer.effect(CitymapBuilder, make);
