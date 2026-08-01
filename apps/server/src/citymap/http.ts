import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CitymapBuilder from "./CitymapBuilder.ts";

export const citymapHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "citymap",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const citymapBuilder = yield* CitymapBuilder.CitymapBuilder;

    return handlers.handle(
      "threadCitymap",
      Effect.fn("environment.citymap.threadCitymap")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);

        const context = yield* projectionSnapshotQuery
          .getThreadCheckpointContext(args.params.threadId)
          .pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
            ),
          );
        if (Option.isNone(context)) {
          return yield* failEnvironmentNotFound("thread_not_found");
        }

        // A thread on a branch should map the tree it actually ran against, so
        // the worktree wins over the project root whenever the thread has one.
        const root = context.value.worktreePath ?? context.value.workspaceRoot;
        return yield* citymapBuilder
          .buildForRoot(root)
          .pipe(Effect.catch((cause) => failEnvironmentInternal("citymap_build_failed", cause)));
      }),
    );
  }),
);
