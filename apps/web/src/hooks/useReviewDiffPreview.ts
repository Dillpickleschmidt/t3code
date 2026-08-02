import type { ReviewDiffPreviewSource, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import { serverEnvironment } from "../state/server";

/**
 * The review diff preview, with the workspace-boundary retry every caller
 * needs and none should own.
 *
 * The server bounds diff requests to its configured cwd, and a project is not
 * always inside it — an ordinary `vp run dev` launches the server from
 * `apps/server`, so a request for the project root is refused outright. The
 * retry at the environment's own cwd has always existed, but it lived inside
 * the 2D panel, which meant the 3D surface hit the same wall and simply died.
 * A workaround that only one caller knows about is a bug for every other one.
 *
 * @module useReviewDiffPreview
 */
export interface ReviewDiffPreviewState {
  readonly sources: ReadonlyArray<ReviewDiffPreviewSource>;
  /** The cwd the answer actually came from, which the retry may have changed. */
  readonly cwd: string | undefined;
  readonly error: string | undefined;
  readonly isPending: boolean;
}

export function useReviewDiffPreview(
  threadRef: ScopedThreadRef | null,
  cwd: string | null | undefined,
  options: {
    readonly baseRef?: string | null;
    readonly ignoreWhitespace: boolean;
    readonly enabled?: boolean;
  },
): ReviewDiffPreviewState {
  const { baseRef, ignoreWhitespace, enabled = true } = options;
  const environmentId = threadRef?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  const input = (at: string) => ({
    cwd: at,
    ...(baseRef ? { baseRef } : {}),
    ignoreWhitespace,
  });

  const primary = useEnvironmentQuery(
    enabled && environmentId && cwd
      ? reviewEnvironment.diffPreview({ environmentId, input: input(cwd) })
      : null,
  );

  // Matched on the server's own words for the rejection, which is how the 2D
  // panel has always spotted it over this transport.
  const shouldRetry =
    primary.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== cwd;

  const fallback = useEnvironmentQuery(
    enabled && shouldRetry && environmentId && serverConfig
      ? reviewEnvironment.diffPreview({ environmentId, input: input(serverConfig.cwd) })
      : null,
  );

  const active = shouldRetry ? fallback : primary;
  return {
    sources: active.data?.sources ?? [],
    cwd: active.data?.cwd ?? undefined,
    error: active.error ?? undefined,
    isPending: active.isPending,
  };
}

/** The source a scope draws, by the kind the store's selection names. */
export function selectSource(
  sources: ReadonlyArray<ReviewDiffPreviewSource>,
  kind: "unstaged" | "branch",
): ReviewDiffPreviewSource | undefined {
  return sources.find(
    (source) => source.kind === (kind === "unstaged" ? "working-tree" : "branch-range"),
  );
}
