import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

/**
 * One file's net line counts within a source.
 *
 * Served rather than counted from `diff`, because `diff` is capped and a
 * capped patch counts short: past the limit a client tallying hunks reports
 * fewer lines than the range actually changed, and every consumer that tallies
 * it reports its own wrong number. `--numstat` has no content to truncate, so
 * these counts stay right where the patch stops — and every view of this
 * source quotes the same figure by construction rather than by agreement.
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
  /** Every file this source touched, whether or not `diff` reached it. */
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
