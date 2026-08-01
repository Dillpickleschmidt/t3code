/**
 * MindwalkSnapshot - the trace and the citymap, built together.
 *
 * The two artifacts are mutually dependent, which is why they are one service
 * and one endpoint rather than two: the citymap needs the trace's target paths
 * to raise ghost buildings for files that no longer exist, and the trace needs
 * the citymap for each target's `fileId` and for `stats.filesInRepo`. mindwalk
 * resolves this with a strict order in a single request (`server.go:834-841`),
 * and this copies it — trace with paths only, then citymap with those paths as
 * ghosts, then backfill the ids, then recount the stats.
 *
 * @module MindwalkSnapshot
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import type { Citymap, MindwalkSnapshot, ThreadId, Trace } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CitymapBuilder from "../citymap/CitymapBuilder.ts";
import { buildCitymap, CITYMAP_VERSION, type InspectedFile } from "../citymap/CitymapLayout.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import * as ProjectionThreadMessages from "../persistence/Services/ProjectionThreadMessages.ts";
import * as ProjectionThreadSessions from "../persistence/Services/ProjectionThreadSessions.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { RepoPathExists } from "./TraceEvent.ts";
import { buildTrace, parseLens, TRACE_ACTIVITY_KINDS } from "./TraceProjection.ts";
import { computeStats } from "./TraceStats.ts";

/** Snapshots kept in the cache, oldest evicted first. */
const CACHE_MAX_ENTRIES = 16;

export class MindwalkSnapshotService extends Context.Service<
  MindwalkSnapshotService,
  {
    /**
     * Build (or serve from cache) one thread's trace and citymap. Returns
     * `Option.none` when the thread does not exist.
     */
    readonly getSnapshot: (
      threadId: ThreadId,
      lens: string | undefined,
    ) => Effect.Effect<Option.Option<MindwalkSnapshot>, ProjectionRepositoryError>;
  }
>()("t3/mindwalk/MindwalkSnapshot/MindwalkSnapshotService") {}

interface CacheEntry {
  readonly fingerprint: string;
  readonly snapshot: MindwalkSnapshot;
}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const activities = yield* ProjectionThreadActivities.ProjectionThreadActivityRepository;
  const messages = yield* ProjectionThreadMessages.ProjectionThreadMessageRepository;
  const sessions = yield* ProjectionThreadSessions.ProjectionThreadSessionRepository;
  const citymapBuilder = yield* CitymapBuilder.CitymapBuilder;

  /**
   * Unlike the citymap's, this key is exact. A thread's activity rows are
   * append-only — never updated, never deleted in place — so the row count is a
   * perfect fingerprint of the log the trace is derived from: same count, same
   * trace, guaranteed. No TTL, no staleness window, and a no-change poll from
   * live-watch costs one index-covered `COUNT(*)` instead of re-parsing
   * megabytes of payloads.
   */
  const cache = new Map<string, CacheEntry>();

  const getSnapshot: MindwalkSnapshotService["Service"]["getSnapshot"] = Effect.fn(
    "MindwalkSnapshot.getSnapshot",
  )(function* (threadId, lensParam) {
    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(threadId);
    if (Option.isNone(context)) return Option.none();
    // The provider comes from the session row, not the thread shell: the shell
    // query only returns *active* threads, and an archived thread projected
    // with the wrong adapter reads every payload as an unfamiliar shape and
    // renders an empty city.
    const session = yield* sessions.getByThreadId({ threadId });
    const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId);

    // A thread on a branch ran against its worktree, so that tree is the one
    // its paths resolve in — the same root the citymap endpoint uses.
    const root = path.resolve(context.value.worktreePath ?? context.value.workspaceRoot);
    const lens = parseLens(lensParam);
    const cacheKey = `${threadId}:${lensParam ?? "main"}`;

    // Fingerprint the rows themselves rather than an activity count. A count
    // cannot see two things: user messages, which `buildTrace` also reads, and
    // in-place rewrites, since `upsert` is ON CONFLICT DO UPDATE and can change
    // a row's kind or payload without changing how many there are. Fetching
    // both row sets first costs one indexed query on a hit, against a build
    // that reads every file in the repository.
    const [traceRows, messageRows] = yield* Effect.all([
      activities.listByThreadIdAndKinds({ threadId, kinds: [...TRACE_ACTIVITY_KINDS] }),
      messages.listByThreadId({ threadId }),
    ]);

    // The snapshot embeds a citymap, so repository state is one of its inputs
    // too: a new commit changes the map without adding a single activity row.
    // CitymapBuilder already keys on commit and dirty state and caches the
    // expensive walk, so consulting it first is cheap and tells us the repo
    // identity to fold into the key. It can legitimately fail — six threads in
    // a real store are rooted at a home directory that is not a repository —
    // and a timeline without buildings still plays; mindwalk degrades the same
    // way.
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    let citymapFailed = false;
    const base = yield* citymapBuilder.buildForRoot(root).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("mindwalk citymap build failed; serving trace only", cause).pipe(
          Effect.as(emptyCitymap(root, generatedAt)),
          Effect.tap(() => Effect.sync(() => (citymapFailed = true))),
        ),
      ),
    );

    const fingerprint = fingerprintRows(traceRows, messageRows, base);
    const cached = cache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprint) {
      yield* Effect.annotateCurrentSpan({ "mindwalk.cache": "hit" });
      return Option.some(cached.snapshot);
    }

    const trace = buildTrace({
      threadId,
      providerName: Option.isSome(session) ? session.value.providerName : null,
      root,
      ...(Option.isSome(shell) ? { title: shell.value.title } : {}),
      ...(Option.isSome(shell) ? { model: modelOf(shell.value) } : {}),
      activities: traceRows,
      messages: messageRows,
      lens,
      repoPathExists: makeRepoPathExists(root, path),
    });

    // A failed build has no repository to raise ghosts against, so it stays
    // empty rather than gaining buildings for files it never saw.
    const citymap = citymapFailed ? base : withGhosts(base, ghostPathsOf(trace));

    const snapshot: MindwalkSnapshot = {
      trace: finalizeTrace(trace, citymap),
      citymap,
    };
    cache.set(cacheKey, { fingerprint, snapshot });
    evictOldest(cache);
    yield* Effect.annotateCurrentSpan({
      "mindwalk.cache": "miss",
      "mindwalk.event_count": snapshot.trace.events.length,
    });
    return Option.some(snapshot);
  });

  return MindwalkSnapshotService.of({ getSnapshot });
});

export const layer = Layer.effect(MindwalkSnapshotService, make);

/**
 * Paths the trace touched that the citymap should raise a ghost building for.
 * Weak targets are excluded, exactly as mindwalk's builder does: a path guessed
 * out of prose must not conjure a building that was never there.
 */
export function ghostPathsOf(trace: Trace): Array<string> {
  const paths = new Set<string>();
  for (const event of trace.events) {
    for (const target of event.targets) {
      if (target.path === "" || target.weak === true) continue;
      paths.add(target.path);
    }
  }
  return [...paths];
}

/**
 * Re-lay the citymap with this thread's ghosts. The expensive half — walking
 * the tree and counting every file's lines — stays cached per root in
 * `CitymapBuilder`; only the treemap is redone, because a ghost changes the
 * layout of the directory it lands in.
 */
export function withGhosts(base: Citymap, ghostPaths: ReadonlyArray<string>): Citymap {
  if (ghostPaths.length === 0) return base;
  const files: Array<InspectedFile> = base.files.map((file) => ({
    path: file.path,
    dir: file.dir,
    lines: file.lines,
    bytes: file.bytes,
    lang: file.lang ?? "",
  }));
  return buildCitymap({
    root: base.repo.root,
    commit: base.repo.commit ?? null,
    dirty: base.repo.dirty,
    generatedAt: base.repo.generatedAt,
    files,
    ghostPaths,
  });
}

/**
 * Backfill each target's `fileId` and recount the stats against the citymap's
 * real file count, carrying over the adapter's error grade — a recount cannot
 * re-derive how the provider reports failures.
 */
export function finalizeTrace(trace: Trace, citymap: Citymap): Trace {
  const ids = new Map(citymap.files.map((file) => [file.path, file.id]));
  const events = trace.events.map((event) => ({
    ...event,
    targets: event.targets.map((target) => {
      const fileId = ids.get(target.path);
      const { fileId: _dropped, ...rest } = target;
      return fileId === undefined ? rest : { ...rest, fileId };
    }),
  }));
  const filesInRepo = citymap.files.reduce((count, file) => (file.ghost ? count : count + 1), 0);
  return {
    ...trace,
    events,
    stats: computeStats(
      { events, marks: trace.marks },
      filesInRepo,
      trace.stats.observability.errors,
    ),
  };
}

function emptyCitymap(root: string, generatedAt: string): Citymap {
  return {
    version: CITYMAP_VERSION,
    repo: { root, dirty: false, generatedAt },
    files: [],
    dirs: [],
    layout: { algorithm: "unavailable", weight: "none" },
  };
}

function modelOf(shell: {
  readonly modelSelection?: { readonly model?: string };
}): string | undefined {
  return shell.modelSelection?.model;
}

/**
 * Whether a repo-relative path exists on disk, memoized for the life of one
 * projection. Weak targets are checked one at a time and a long thread scrapes
 * the same handful of paths over and over, so the memo turns thousands of
 * `stat` calls into tens.
 *
 * Synchronous on purpose: this is called from inside the verbatim-ported
 * target extraction, and threading an Effect through it would fork that code
 * away from the reference it has to stay diffable against.
 */
function makeRepoPathExists(root: string, path: typeof Path.Path.Service): RepoPathExists {
  const seen = new Map<string, boolean>();
  return (relativePath) => {
    if (root === "" || relativePath === "") return false;
    const cached = seen.get(relativePath);
    if (cached !== undefined) return cached;
    let exists = false;
    try {
      exists = NodeFS.existsSync(path.join(root, relativePath));
    } catch {
      // Fail closed, as mindwalk's `repoPathExists` does: an unreadable path is
      // not a path we should colour a building for.
      exists = false;
    }
    seen.set(relativePath, exists);
    return exists;
  };
}

function evictOldest(cache: Map<string, CacheEntry>): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/**
 * A cheap content fingerprint over the two row sets `buildTrace` consumes.
 *
 * Covers every input the snapshot has: both row sets and the repository state
 * the citymap is built from. Catches inserts, deletes, reordering, and rewrites
 * — including payload-only ones, which `upsert`'s ON CONFLICT DO UPDATE makes possible without moving
 * the row count. Serialising each payload costs milliseconds on the largest
 * thread in the store, against a miss that reads every file in the repository.
 */
function fingerprintRows(
  traceRows: ReadonlyArray<{
    readonly activityId: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
    readonly payload: unknown;
  }>,
  messageRows: ReadonlyArray<{
    readonly messageId: string;
    readonly createdAt: string;
    readonly role: string;
    readonly text: string;
  }>,
  citymap: {
    readonly repo: { readonly root: string; readonly commit?: string; readonly dirty: boolean };
  },
): string {
  let hash = 0x811c9dc5;
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x7c;
    hash = Math.imul(hash, 0x01000193);
  };
  for (const row of traceRows) {
    mix(`${row.activityId}|${row.kind}|${row.sequence ?? ""}|${row.createdAt}`);
    mix(JSON.stringify(row.payload) ?? "");
  }
  // `buildTrace` reads role and text, and the message repository rewrites both
  // in place while a turn streams.
  for (const row of messageRows) {
    mix(`${row.messageId}|${row.createdAt}|${row.role}|${row.text}`);
  }
  mix(`${citymap.repo.root}|${citymap.repo.commit ?? ""}|${citymap.repo.dirty}`);
  return `${traceRows.length}:${messageRows.length}:${(hash >>> 0).toString(36)}`;
}
