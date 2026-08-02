import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  /**
   * Also count every changed file, which costs a second git call per source
   * and one more per untracked file. Off by default: the 2D panel renders the
   * capped patch and states plainly that it is showing part of a range, so the
   * counts it wants are the ones it can see. Only a caller that draws the
   * *whole* range — 3D Diff's terrain, where a missing file is a missing
   * building rather than a line below the fold — needs to pay for this.
   */
  includeFileStats: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

/**
 * One file's net line counts within a source, present only when the caller
 * asked for them.
 *
 * These describe the whole range, where `diff` describes as much of it as fits
 * under the preview cap. That is not a correction of the patch — a preview is
 * meant to be bounded, and the panel showing it says so — it is a different
 * question, for a consumer that has to place every changed file rather than
 * list the first few hundred kilobytes of them.
 *
 * Coming off the same call that resolved the refs and flags is the point: a
 * caller computing them separately has to re-derive the flags that decide what
 * git counts, and one `--minimal` between the two spellings is a file whose
 * line count differs between panels.
 */
export const ReviewDiffFileStat = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  /** Every file this source touched. Empty unless `includeFileStats`. */
  files: Schema.Array(ReviewDiffFileStat),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
