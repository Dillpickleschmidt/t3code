/**
 * The service seam: real projection repositories over an in-memory database,
 * with the citymap builder and the thread query stubbed. What is under test is
 * the wiring the pure helpers cannot cover — the cache key, the read filter,
 * and what happens when the citymap build fails.
 */
import { EventId, IsoDateTime, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CitymapBuilder from "../citymap/CitymapBuilder.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import * as MindwalkSnapshot from "./MindwalkSnapshot.ts";
import { MindwalkSnapshotService } from "./MindwalkSnapshot.ts";

const ROOT = "/repo";
const PROJECT_ID = ProjectId.make("project-1");

/** Counts builds so a cache hit is observable rather than inferred. */
let citymapBuilds = 0;
let citymapFails = false;

const citymapBuilderLayer = Layer.mock(CitymapBuilder.CitymapBuilder)({
  buildForRoot: (root) =>
    Effect.suspend(() => {
      citymapBuilds += 1;
      return citymapFails
        ? Effect.fail(
            new CitymapBuilder.CitymapBuildError({ root, operation: "listWorkspaceFiles" }),
          )
        : Effect.succeed({
            version: 1,
            repo: { root, dirty: false, generatedAt: "1970-01-01T00:00:00Z" },
            files: [
              {
                id: 0,
                path: "src/a.ts",
                dir: "src",
                lines: 10,
                bytes: 120,
                lang: "typescript",
                rect: { x: 0, z: 0, w: 1, d: 1 },
                ghost: false,
              },
            ],
            dirs: [],
            layout: { algorithm: "squarified-treemap-v1", weight: "w" },
          });
    }),
});

const projectionSnapshotQueryLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
  getThreadCheckpointContext: (threadId) =>
    Effect.succeed(
      threadId === ThreadId.make("missing")
        ? Option.none()
        : Option.some({
            threadId,
            projectId: PROJECT_ID,
            workspaceRoot: ROOT,
            worktreePath: null,
            checkpoints: [],
          }),
    ),
  getThreadShellById: () => Effect.succeed(Option.none()),
});

const layer = it.layer(
  MindwalkSnapshot.layer.pipe(
    Layer.provideMerge(citymapBuilderLayer),
    Layer.provideMerge(projectionSnapshotQueryLayer),
    Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Path.layer),
  ),
);

/** Every case needs the thread's provider on record before it projects. */
const claudeSession = (threadId: ThreadId) => ({
  threadId,
  status: "idle" as const,
  providerName: "claudeAgent",
  providerInstanceId: null,
  runtimeMode: "auto" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: IsoDateTime.make("2026-02-28T19:00:00.000Z"),
});

const toolActivity = (threadId: ThreadId, id: string, sequence: number, filePath: string) => ({
  activityId: EventId.make(id),
  threadId,
  turnId: null,
  tone: "tool" as const,
  kind: "tool.completed",
  summary: "Edit",
  payload: {
    itemType: "file_change",
    data: {
      toolName: "Edit",
      input: { file_path: filePath },
      result: { content: "", is_error: false },
    },
  },
  sequence,
  createdAt: IsoDateTime.make(`2026-02-28T19:00:0${sequence}.000Z`),
});

const noiseActivity = (threadId: ThreadId, id: string, sequence: number) => ({
  activityId: EventId.make(id),
  threadId,
  turnId: null,
  tone: "info" as const,
  kind: "context-window.updated",
  summary: "noise",
  payload: { used: 1 },
  sequence,
  createdAt: IsoDateTime.make(`2026-02-28T19:00:0${sequence}.000Z`),
});

layer("MindwalkSnapshotService", (it) => {
  it.effect("returns none for a thread that does not exist", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      assert.isTrue(Option.isNone(yield* service.getSnapshot(ThreadId.make("missing"), undefined)));
    }),
  );

  it.effect("builds a trace and citymap together, ignoring bookkeeping activities", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-build");
      yield* (yield* ProjectionThreadSessionRepository).upsert(claudeSession(threadId));
      yield* activities.upsert(toolActivity(threadId, "b-1", 0, "/repo/src/a.ts"));
      yield* activities.upsert(noiseActivity(threadId, "b-2", 1));

      const snapshot = yield* service.getSnapshot(threadId, undefined);
      assert.isTrue(Option.isSome(snapshot));
      const { trace, citymap } = Option.getOrThrow(snapshot);

      assert.equal(trace.events.length, 1);
      assert.equal(trace.events[0]?.tool, "Edit");
      // The id is backfilled from the citymap, which is what lets the scene
      // find the building this event lit.
      assert.equal(trace.events[0]?.targets[0]?.fileId, 0);
      assert.equal(trace.stats.filesInRepo, 1);
      assert.equal(citymap.files.length, 1);
    }),
  );

  it.effect("raises a ghost building for a file the repository no longer has", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-ghost");
      yield* (yield* ProjectionThreadSessionRepository).upsert(claudeSession(threadId));
      yield* activities.upsert(toolActivity(threadId, "g-1", 0, "/repo/src/deleted.ts"));

      const { trace, citymap } = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      const ghost = citymap.files.find((file) => file.path === "src/deleted.ts");
      assert.isTrue(ghost?.ghost);
      assert.equal(trace.events[0]?.targets[0]?.fileId, ghost?.id);
      // A ghost is not a file in the repository.
      assert.equal(trace.stats.filesInRepo, 1);
    }),
  );

  it.effect("invalidates the cache on anything the trace reads, and nothing else", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      const activities = yield* ProjectionThreadActivityRepository;
      const messages = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-cache");
      yield* (yield* ProjectionThreadSessionRepository).upsert(claudeSession(threadId));
      yield* activities.upsert(toolActivity(threadId, "c-1", 0, "/repo/src/a.ts"));

      // The builder is consulted every request — that is how a new commit is
      // noticed — but it caches the walk internally, and the snapshot itself
      // is reused, which is what the cache is for.
      const first = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      const second = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      assert.strictEqual(first, second);

      // An activity of a kind the trace never reads is not an input, so it
      // must not force a rebuild. A row count could not tell the difference.
      yield* activities.upsert(noiseActivity(threadId, "c-2", 1));
      assert.strictEqual(Option.getOrThrow(yield* service.getSnapshot(threadId, undefined)), first);

      // A user message is an input — it becomes a mark — but adds no activity
      // row, so a count-based key would have served this stale.
      yield* messages.upsert({
        messageId: MessageId.make("msg-cache"),
        threadId,
        turnId: null,
        role: "user",
        text: "and now this",
        isStreaming: false,
        createdAt: IsoDateTime.make("2026-02-28T19:05:00.000Z"),
        updatedAt: IsoDateTime.make("2026-02-28T19:05:00.000Z"),
      });
      const third = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      assert.notStrictEqual(third, first);

      // `upsert` is ON CONFLICT DO UPDATE, so rewriting an existing activity
      // leaves the count unchanged while changing what the trace projects.
      yield* activities.upsert(toolActivity(threadId, "c-1", 0, "/repo/src/rewritten.ts"));
      const fourth = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      assert.notStrictEqual(fourth, third);
    }),
  );

  it.effect("caches each lens separately", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-lens");
      yield* (yield* ProjectionThreadSessionRepository).upsert(claudeSession(threadId));
      yield* activities.upsert(toolActivity(threadId, "l-1", 0, "/repo/src/a.ts"));

      const main = Option.getOrThrow(yield* service.getSnapshot(threadId, "main"));
      const agent = Option.getOrThrow(yield* service.getSnapshot(threadId, "agent:toolu_1"));
      assert.equal(main.trace.events.length, 1);
      // Nothing carries the attribution edge yet, so an agent lens is empty.
      assert.equal(agent.trace.events.length, 0);
    }),
  );

  it.effect("serves the trace with an empty citymap when the build fails", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-degraded");
      yield* (yield* ProjectionThreadSessionRepository).upsert(claudeSession(threadId));
      yield* activities.upsert(toolActivity(threadId, "d-1", 0, "/repo/src/a.ts"));

      citymapFails = true;
      const { trace, citymap } = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      citymapFails = false;

      // You lose the buildings, not the timeline.
      assert.equal(trace.events.length, 1);
      assert.deepEqual(citymap.files, []);
      assert.equal(citymap.layout.algorithm, "unavailable");
      assert.equal(trace.stats.filesInRepo, 0);
      assert.isUndefined(trace.events[0]?.targets[0]?.fileId);
    }),
  );

  it.effect("merges user messages onto the timeline as marks", () =>
    Effect.gen(function* () {
      const service = yield* MindwalkSnapshotService;
      const activities = yield* ProjectionThreadActivityRepository;
      const messages = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-marks");
      yield* (yield* ProjectionThreadSessionRepository).upsert(claudeSession(threadId));

      yield* messages.upsert({
        messageId: MessageId.make("msg-1"),
        threadId,
        turnId: null,
        role: "user",
        text: "fix the login bug",
        isStreaming: false,
        createdAt: IsoDateTime.make("2026-02-28T19:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-02-28T19:00:00.000Z"),
      });
      yield* activities.upsert(toolActivity(threadId, "m-1", 1, "/repo/src/a.ts"));
      yield* messages.upsert({
        messageId: MessageId.make("msg-2"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "done",
        isStreaming: false,
        createdAt: IsoDateTime.make("2026-02-28T19:00:02.000Z"),
        updatedAt: IsoDateTime.make("2026-02-28T19:00:02.000Z"),
      });

      const { trace } = Option.getOrThrow(yield* service.getSnapshot(threadId, undefined));
      // Only the user's turn is a mark, and it sits before the work it caused.
      assert.deepEqual(trace.marks, [{ seq: 0, type: "user-message", note: "fix the login bug" }]);
      assert.equal(trace.stats.userTurns, 1);
    }),
  );
});
