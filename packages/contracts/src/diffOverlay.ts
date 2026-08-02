/**
 * DiffOverlay - the per-commit, per-file churn the 3D Diff surface scrubs.
 *
 * Unlike the trace, this has no mindwalk counterpart: mindwalk visualises what
 * an agent did, and this visualises what a range of commits changed. What it
 * shares is the citymap, which is why the two ship the same way — one endpoint
 * returning the overlay and the map it lands on, so a client never has to
 * reconcile two independently built layouts.
 *
 * Steps run oldest to newest and each carries only its own change, which is
 * also how each is shown: the scrubber walks the branch commit by commit
 * rather than watching a total accumulate, matching every other diff view in
 * T3 and any ordinary git client.
 *
 * A step's counts are *churn* rather than a net diff — ten lines swapped for
 * ten others is twenty, not zero — because the surface is asking "how much
 * work landed here", not "what does the patch say".
 *
 * This carries **only what nothing else in T3 already answers**: the per-commit
 * breakdown, which no 2D view has, and the citymap. What a scope *currently*
 * shows — the working tree, the branch against its base — is a
 * `ReviewDiffPreviewSource`, and 3D Diff reads that same source the 2D panel
 * does. It used to net the branch here as well, and the two spellings promptly
 * disagreed by a line over a `--minimal` that only one of them passed. A view
 * that re-asks a question T3 already answers will drift from it; the fix is
 * not to test the two into agreement but to leave only one asker.
 */
import * as Schema from "effect/Schema";

import { Citymap } from "./citymap.ts";
import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * One file's churn within one step. A binary file reports zero on both counts,
 * the way `git --numstat` does: it has no lines to count, so it gets a
 * building but no height.
 */
export const DiffOverlayFile = Schema.Struct({
  path: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type DiffOverlayFile = typeof DiffOverlayFile.Type;

/**
 * One scrubber position: a commit.
 *
 * Only commits. The uncommitted tree used to ride along as a final step, back
 * when the scrubber was the whole surface; it is now a scope of its own, and
 * it reads the review preview's `working-tree` source like the 2D panel does
 * rather than being computed a second time here.
 */
export const DiffOverlayStep = Schema.Struct({
  /** The commit's full sha. */
  id: Schema.String,
  kind: Schema.Literal("commit"),
  title: Schema.String,
  /**
   * Committer date, not author date: it is the one that agrees with the order
   * git walked these commits in, which is the order the scrubber steps them.
   */
  committedAt: Schema.String,
  files: Schema.Array(DiffOverlayFile),
});
export type DiffOverlayStep = typeof DiffOverlayStep.Type;

/**
 * Which window the steps cover.
 *
 * - `branch-range` is the same range the 2D Diff panel's branch source shows,
 *   resolved by the same code, so the two agree by construction.
 * - `recent-commits` is the fallback for a branch that has not diverged from
 *   its base — committing straight to the default branch is routine, and an
 *   empty scrubber is worse than a recent-history one. `baseRef` is null here
 *   because the window is a commit count, not a ref.
 * - `working-tree` means there were no commits to step at all, so there are no
 *   steps. The working-tree scope still has something to show; it just does
 *   not come from here.
 */
export const DiffOverlayRange = Schema.Struct({
  kind: Schema.Literals(["branch-range", "recent-commits", "working-tree"]),
  baseRef: Schema.NullOr(Schema.String),
  headRef: Schema.NullOr(Schema.String),
});
export type DiffOverlayRange = typeof DiffOverlayRange.Type;

export const DiffOverlay = Schema.Struct({
  cwd: Schema.String,
  generatedAt: Schema.String,
  range: DiffOverlayRange,
  steps: Schema.Array(DiffOverlayStep),
  citymap: Citymap,
});
export type DiffOverlay = typeof DiffOverlay.Type;
