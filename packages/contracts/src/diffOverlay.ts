/**
 * DiffOverlay - the per-commit, per-file churn the 3D Diff surface scrubs.
 *
 * Unlike the trace, this has no mindwalk counterpart: mindwalk visualises what
 * an agent did, and this visualises what a range of commits changed. What it
 * shares is the citymap, which is why the two ship the same way — one endpoint
 * returning the overlay and the map it lands on, so a client never has to
 * reconcile two independently built layouts.
 *
 * Steps run oldest to newest and each carries only its own change; the client
 * sums steps 1..i for the frame at position i. Sums are *churn*, not a net
 * diff — a line added and later removed counts twice, because the surface is
 * asking "how much work landed here", not "what does the patch say".
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
 * One scrubber position: a commit, or the uncommitted working tree that always
 * comes last. Present only when it changed something — a clean tree adds no
 * step rather than a duplicate of the one before it.
 */
export const DiffOverlayStep = Schema.Struct({
  /** A commit's full sha, or `working-tree`, matching the review source's id. */
  id: Schema.String,
  kind: Schema.Literals(["commit", "working-tree"]),
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
 * - `working-tree` means there were no commits to step at all, so the only
 *   step (if any) is the uncommitted one.
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
