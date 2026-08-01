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
import * as MindwalkSnapshot from "./MindwalkSnapshot.ts";

export const mindwalkHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mindwalk",
  Effect.fnUntraced(function* (handlers) {
    const snapshots = yield* MindwalkSnapshot.MindwalkSnapshotService;

    return handlers.handle(
      "threadSnapshot",
      Effect.fn("environment.mindwalk.threadSnapshot")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);

        const snapshot = yield* snapshots
          .getSnapshot(args.params.threadId, args.query.lens)
          .pipe(Effect.catch((cause) => failEnvironmentInternal("trace_projection_failed", cause)));
        if (Option.isNone(snapshot)) {
          return yield* failEnvironmentNotFound("thread_not_found");
        }
        return snapshot.value;
      }),
    );
  }),
);
