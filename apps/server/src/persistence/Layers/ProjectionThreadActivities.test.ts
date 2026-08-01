import { EventId, IsoDateTime, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

// The in-memory database is shared across this file, so each case works in its
// own thread rather than relying on a clean table.
const threads = (name: string) =>
  [ThreadId.make(`thread-${name}`), ThreadId.make(`thread-${name}-other`)] as const;

const activity = (thread: ThreadId, id: string, kind: string, sequence: number) => ({
  activityId: EventId.make(id),
  threadId: thread,
  turnId: null,
  tone: "tool" as const,
  kind,
  summary: kind,
  payload: { itemType: "command_execution" },
  sequence,
  createdAt: IsoDateTime.make(`2026-02-28T19:00:0${sequence}.000Z`),
});

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("filters to the requested kinds, in the same order as an unfiltered list", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const [threadId, otherThreadId] = threads("kinds");
      yield* repository.upsert(activity(threadId, "a-1", "tool.started", 0));
      yield* repository.upsert(activity(threadId, "a-2", "tool.completed", 1));
      yield* repository.upsert(activity(threadId, "a-3", "tool.updated", 2));
      yield* repository.upsert(activity(threadId, "a-4", "context-compaction", 3));
      yield* repository.upsert(activity(threadId, "a-5", "tool.completed", 4));
      yield* repository.upsert(activity(otherThreadId, "b-1", "tool.completed", 0));

      const rows = yield* repository.listByThreadIdAndKinds({
        threadId,
        kinds: ["tool.completed", "context-compaction"],
      });

      assert.deepEqual(
        rows.map((row) => row.activityId),
        ["a-2", "a-4", "a-5"],
      );
    }),
  );

  it.effect("returns nothing for an empty kind list rather than every row", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const [threadId] = threads("empty-kinds");
      yield* repository.upsert(activity(threadId, "c-1", "tool.completed", 0));

      assert.deepEqual(yield* repository.listByThreadIdAndKinds({ threadId, kinds: [] }), []);
    }),
  );

  it.effect("counts every row for the thread, and only that thread's", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const [threadId, otherThreadId] = threads("count");
      assert.equal(yield* repository.countByThreadId({ threadId }), 0);

      yield* repository.upsert(activity(threadId, "d-1", "tool.completed", 0));
      yield* repository.upsert(activity(threadId, "d-2", "tool.updated", 1));
      yield* repository.upsert(activity(otherThreadId, "e-1", "tool.completed", 0));

      assert.equal(yield* repository.countByThreadId({ threadId }), 2);
      assert.equal(yield* repository.countByThreadId({ threadId: otherThreadId }), 1);
    }),
  );

  it.effect("does not double count an upsert of the same activity", () =>
    Effect.gen(function* () {
      // The count is the trace cache's fingerprint, so a re-projected row must
      // not look like new work.
      const repository = yield* ProjectionThreadActivityRepository;
      const [threadId] = threads("upsert");
      yield* repository.upsert(activity(threadId, "f-1", "tool.completed", 0));
      yield* repository.upsert(activity(threadId, "f-1", "tool.completed", 0));

      assert.equal(yield* repository.countByThreadId({ threadId }), 1);
    }),
  );
});
