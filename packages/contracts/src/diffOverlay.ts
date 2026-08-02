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
 * The whole range as one frame is a *different question* and so a different
 * field: `aggregate` is the net diff across the window, which is what the 2D
 * Diff panel's "Branch changes" entry shows. Summing the steps would answer
 * with churn instead and the two panels would disagree under the same name,
 * which is the failure the scopes exist to prevent.
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

/**
 * The window as one net frame — `git diff --numstat <base>...HEAD` — rather
 * than the churn of its steps summed.
 *
 * Three dots, because that is what the 2D panel's branch source runs
 * (`GitVcsDriverCore.getReviewDiffPreview`), and rename detection left on for
 * the same reason: this frame is read against that panel's numbers, so it has
 * to ask git the identical question. That makes it deliberately asymmetric
 * with `steps`, which run `--no-renames` so a rename reads as one building
 * emptying and another filling — the right answer for a single commit on a
 * city, and the wrong one for a total that has to match a number on screen
 * somewhere else.
 *
 * Committed work only. Uncommitted changes are the working-tree scope's, the
 * same split the 2D panel makes.
 *
 * Null when the window has no base to net against: a `working-tree` range has
 * no commits at all, and a `recent-commits` range whose oldest step is the
 * repository's root commit has nothing before it to diff from. The 2D panel
 * shows an empty branch diff in both cases, so this degrades to parity with it
 * rather than inventing a number.
 */
export const DiffOverlay = Schema.Struct({
  cwd: Schema.String,
  generatedAt: Schema.String,
  range: DiffOverlayRange,
  steps: Schema.Array(DiffOverlayStep),
  aggregate: Schema.NullOr(Schema.Array(DiffOverlayFile)),
  citymap: Citymap,
});
export type DiffOverlay = typeof DiffOverlay.Type;
