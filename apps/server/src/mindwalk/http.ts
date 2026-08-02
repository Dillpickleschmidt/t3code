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
import * as DiffOverlay from "./DiffOverlay.ts";
import * as MindwalkSnapshot from "./MindwalkSnapshot.ts";

export const mindwalkHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mindwalk",
  Effect.fnUntraced(function* (handlers) {
    const snapshots = yield* MindwalkSnapshot.MindwalkSnapshotService;
    const diffOverlays = yield* DiffOverlay.DiffOverlayService;

    return handlers
      .handle(
        "threadSnapshot",
        Effect.fn("environment.mindwalk.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          const snapshot = yield* snapshots
            .getSnapshot(args.params.threadId, args.query.lens)
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("trace_projection_failed", cause)),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return snapshot.value;
        }),
      )
      .handle(
        "diffOverlay",
        Effect.fn("environment.mindwalk.diffOverlay")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          return yield* diffOverlays
            .getOverlay({
              cwd: args.query.cwd,
              // Absent means the caller did not say; T3's own default is on,
              // so defaulting off here would disagree with the 2D panel for
              // any client that forgets to ask.
              ignoreWhitespace: args.query.ignoreWhitespace !== "false",
            })
            .pipe(
              Effect.catchTags({
                // A path the caller may not read answers the same as one that is
                // not there, so the response says nothing about what exists
                // outside the workspace.
                DiffOverlayOutsideWorkspaceError: () => failEnvironmentNotFound("cwd_not_found"),
                DiffOverlayError: (cause) => failEnvironmentInternal("diff_overlay_failed", cause),
              }),
            );
        }),
      );
  }),
);
