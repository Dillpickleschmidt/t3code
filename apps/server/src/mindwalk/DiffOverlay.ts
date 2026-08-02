/**
 * DiffOverlay - the commit-stepped churn the 3D Diff surface scrubs, plus the
 * citymap it lands on.
 *
 * The window is not ours to invent. `ReviewService.getDiffPreview` already
 * resolves which base the 2D Diff panel is diffing against — through
 * `gh-merge-base`, the remote's default branch, and a candidate walk — and the
 * 3D surface's last frame has to be the same change that panel shows or
 * neither is trustworthy. So this asks that service for the answer and reads
 * the refs off it, discarding the patches it also builds. That waste is real
 * and measured — 255ms of a 467ms warm request on this repo — but the
 * alternative is a second implementation of base resolution that drifts, and
 * the call disappears entirely the day the surface grows a base-ref picker and
 * names its own base.
 *
 * The steps themselves come from `--numstat`, not from patches: two git calls
 * cover the whole scrubber at any window size, because one `git log` prints
 * every commit's per-file counts at once.
 *
 * @module DiffOverlay
 */
import type { Citymap, DiffOverlay, DiffOverlayFile, DiffOverlayStep } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as CitymapBuilder from "../citymap/CitymapBuilder.ts";
import { CITYMAP_VERSION } from "../citymap/CitymapLayout.ts";
import * as ReviewService from "../review/ReviewService.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { consumeNumstatRecord, stripLeadingNewlines } from "../vcs/numstat.ts";
import { withGhosts } from "./MindwalkSnapshot.ts";

/**
 * Commits shown when the branch has not diverged from its base. Committing
 * straight to the default branch is routine here, which leaves `base..HEAD`
 * empty and would leave the scrubber empty with it. This repo runs 15-25
 * commits on an active day, so twenty is roughly "the work in front of you"
 * — an arbitrary number, but a bounded one, and the eventual base-ref picker
 * replaces it rather than tunes it.
 */
const RECENT_COMMIT_STEPS = 20;
/**
 * A numstat log is ~30 bytes per changed file, so this covers a range of tens
 * of thousands of file-touches. Past it we fail rather than parse a prefix: a
 * silently truncated log renders as a scrubber that quietly forgets its oldest
 * commits, which is worse than an error.
 */
const LOG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The requested cwd is not inside the workspace. Its own class rather than an
 * `operation` on the error below, because it is the one failure a caller
 * branches on: the HTTP layer answers it `cwd_not_found` while everything else
 * is an internal error. `WorkspacePathOutsideRootError` sits beside
 * `WorkspaceFileSystemOperationError` for the same reason.
 */
export class DiffOverlayOutsideWorkspaceError extends Schema.TaggedErrorClass<DiffOverlayOutsideWorkspaceError>()(
  "DiffOverlayOutsideWorkspaceError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Diff overlay cwd must stay within the configured workspace root: ${this.cwd}`;
  }
}

/** A git call the overlay needed failed or came back truncated. Diagnostic. */
export class DiffOverlayError extends Schema.TaggedErrorClass<DiffOverlayError>()(
  "DiffOverlayError",
  {
    cwd: Schema.String,
    operation: Schema.Literals(["log", "logTruncated", "deleted", "deletedTruncated"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Diff overlay build failed during "${this.operation}" for ${this.cwd}.`;
  }
}

/**
 * `ignoreWhitespace` is the client's setting, not a server default. The 2D
 * Diff panel sends it on every request, and a 3D surface that answered a
 * different question about the same range would make both untrustworthy —
 * a whitespace-only reformat is a tower in one and nothing in the other.
 */
export interface DiffOverlayInput {
  readonly cwd: string;
  readonly ignoreWhitespace: boolean;
}

export class DiffOverlayService extends Context.Service<
  DiffOverlayService,
  {
    /**
     * Build the overlay for a working directory. The cwd is bounded to the
     * configured workspace by `ReviewService` before any git runs against it.
     */
    readonly getOverlay: (
      input: DiffOverlayInput,
    ) => Effect.Effect<DiffOverlay, DiffOverlayError | DiffOverlayOutsideWorkspaceError>;
  }
>()("t3/mindwalk/DiffOverlay/DiffOverlayService") {}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const review = yield* ReviewService.ReviewService;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const citymapBuilder = yield* CitymapBuilder.CitymapBuilder;

  const getOverlay: DiffOverlayService["Service"]["getOverlay"] = Effect.fn(
    "DiffOverlay.getOverlay",
  )(function* (input) {
    const cwd = path.resolve(input.cwd);
    const { ignoreWhitespace } = input;
    yield* Effect.annotateCurrentSpan({ "diffOverlay.cwd": cwd });

    // The cwd is the client's, so it is bounded before anything reads the disk
    // at it. Explicitly, and not as a side effect of the `getDiffPreview` call
    // below: that call exists only to borrow the 2D panel's refs and is meant
    // to disappear once this surface names its own base, which would silently
    // take the boundary with it.
    yield* review
      .assertWorkspaceBoundCwd(cwd)
      .pipe(Effect.mapError((cause) => new DiffOverlayOutsideWorkspaceError({ cwd, cause })));

    const generatedAt = DateTime.formatIso(yield* DateTime.now);

    // The refs, and only the refs. A cwd that is not a repository at all comes
    // back as no sources rather than a failure, and degrades to a citymap with
    // an empty scrubber.
    const preview = yield* review
      .getDiffPreview({ cwd, ignoreWhitespace })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("diff overlay review preview failed; no refs to step", cause).pipe(
            Effect.as(null),
          ),
        ),
      );
    const branchSource = preview?.sources.find((source) => source.kind === "branch-range") ?? null;

    const handle = yield* registry.detect({ cwd }).pipe(Effect.orElseSucceed(() => null));
    const driver = handle?.kind === "git" ? handle.driver : null;

    // Everything below runs at the repository root, not at the requested cwd.
    // `git log --numstat` reports paths relative to the root wherever it runs,
    // while the citymap walks whatever directory it is handed — so a cwd of
    // `<repo>/src` would pair root-relative step paths against a citymap of
    // `src` alone, and every column would miss its building and fall through
    // to a ghost. This is a repository view, so it resolves to the repository.
    const root = handle?.repository.rootPath ?? cwd;

    const runGit = driver ? makeRunGit(root, driver, ignoreWhitespace) : null;
    const { range, steps } = runGit
      ? yield* readSteps(root, runGit, branchSource?.baseRef ?? null, branchSource?.headRef ?? null)
      : { range: workingTreeOnlyRange(), steps: [] as ReadonlyArray<DiffOverlayStep> };

    // A repository the builder cannot read still deserves a scrubber; the
    // trace endpoint degrades the same way, and for the same reason.
    let citymapFailed = false;
    const base = yield* citymapBuilder.buildForRoot(root).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("diff overlay citymap build failed; serving steps only", cause).pipe(
          Effect.as(emptyCitymap(root, generatedAt)),
          Effect.tap(() => Effect.sync(() => (citymapFailed = true))),
        ),
      ),
    );

    // A file deleted somewhere in the range is absent from a citymap built
    // from the current tree, so it would have nowhere to draw its red column.
    // Ghosts are the same mechanism the trace uses for the same problem.
    //
    // Uncommitted deletions are asked for by name here even though their
    // *counts* belong to the review preview. Layout is this endpoint's job —
    // only it builds the city — and a path list has no numbers in it to
    // disagree with anyone about.
    const deleted = runGit ? yield* readUncommittedDeletions(root, runGit) : [];
    const citymap = citymapFailed ? base : withGhosts(base, ghostPathsOf(steps, deleted));

    yield* Effect.annotateCurrentSpan({
      "diffOverlay.range": range.kind,
      "diffOverlay.step_count": steps.length,
    });
    // The root, not the request: the payload describes that repository, and
    // echoing back a subdirectory the citymap does not cover would be a lie
    // the client would key its cache on.
    return { cwd: root, generatedAt, range, steps, citymap } satisfies DiffOverlay;
  });

  /**
   * The commit steps plus the working-tree step, and which window they came
   * from. `baseRef` is what the 2D panel resolved; an empty range against it
   * means the branch has not diverged, which is the fallback's whole reason
   * for existing.
   */
  const readSteps = Effect.fn("DiffOverlay.readSteps")(function* (
    cwd: string,
    runGit: RunGit,
    baseRef: string | null,
    headRef: string | null,
  ) {
    const readLog = Effect.fn("DiffOverlay.readLog")(function* (revisions: ReadonlyArray<string>) {
      const result = yield* runGit("log", [...LOG_ARGS, ...revisions, "--"]);
      if (result.exitCode !== 0) return [];
      if (result.stdoutTruncated) {
        return yield* Effect.fail(new DiffOverlayError({ cwd, operation: "logTruncated" }));
      }
      return parseCommitLog(result.stdout);
    });

    // Two dots gives our commits only; three would add the base branch's too.
    // The 2D panel's diff uses three for the same range — log and diff read
    // dots differently, so the mismatch is correct and not a typo.
    const ranged = baseRef ? yield* readLog([`${baseRef}..HEAD`]) : [];
    const commits =
      ranged.length > 0 ? ranged : yield* readLog([`--max-count=${RECENT_COMMIT_STEPS}`, "HEAD"]);
    const kind =
      ranged.length > 0 ? "branch-range" : commits.length > 0 ? "recent-commits" : "working-tree";

    return {
      range: {
        kind,
        // The fallback's window is a commit count, so naming a base ref it did
        // not use would be a lie the client would then render.
        baseRef: kind === "branch-range" ? baseRef : null,
        headRef: kind === "branch-range" ? headRef : null,
      },
      steps: commits,
    } as const;
  });
  /**
   * Paths deleted but not committed, for the citymap to raise ghosts against.
   *
   * Names only. The counts for these files are the review preview's — this
   * endpoint stopped computing what the working tree changed — but the city
   * has to be laid out before anyone can draw on it, and a building that was
   * never placed cannot be coloured in later.
   */
  const readUncommittedDeletions = Effect.fn("DiffOverlay.readUncommittedDeletions")(function* (
    cwd: string,
    runGit: RunGit,
  ) {
    const result = yield* runGit("deleted", [
      "diff",
      "--name-only",
      "--diff-filter=D",
      "-z",
      "HEAD",
      "--",
    ]);
    if (result.exitCode !== 0) return [];
    if (result.stdoutTruncated) {
      return yield* Effect.fail(new DiffOverlayError({ cwd, operation: "deletedTruncated" }));
    }
    return result.stdout.split("\0").filter((entry) => entry.length > 0);
  });

  return DiffOverlayService.of({ getOverlay });
});

export const layer = Layer.effect(DiffOverlayService, make);

type RunGit = (
  operation: DiffOverlayError["operation"],
  args: ReadonlyArray<string>,
) => Effect.Effect<VcsProcess.VcsProcessOutput, DiffOverlayError>;

/**
 * Every git call this module makes runs through here: non-zero exits are
 * outcomes to read rather than failures (an empty range, a `--no-index` diff
 * that found a difference), while a spawn or timeout failure is real.
 */
function makeRunGit(
  cwd: string,
  driver: VcsDriver.VcsDriver["Service"],
  ignoreWhitespace: boolean,
): RunGit {
  // Every command that *counts lines* takes the flag, so the log, the tracked
  // diff and each untracked diff all answer the same question — applying it to
  // some and not others would be a disagreement inside one response.
  //
  // `ls-files` only enumerates paths and rejects the flag outright, so the
  // subcommand decides rather than the operation label, which lumps the
  // untracked listing together with the diffs it feeds.
  const withWhitespace = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
    const subcommand = args[0];
    if (!ignoreWhitespace || (subcommand !== "log" && subcommand !== "diff")) return args;
    return [subcommand, "--ignore-all-space", ...args.slice(1)];
  };
  return (operation, args) =>
    driver
      .execute({
        operation: `DiffOverlay.${operation}`,
        cwd,
        args: withWhitespace(args),
        allowNonZeroExit: true,
        maxOutputBytes: LOG_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.mapError((cause) => new DiffOverlayError({ cwd, operation, cause })));
}

/**
 * `--no-renames` so a rename reads as the old building emptying and a new one
 * filling, which is what a city actually shows; it also keeps every record a
 * flat triple. `--diff-merges=first-parent` alongside `--first-parent` so a
 * merge contributes the churn it brought in as one step, instead of the
 * nothing that `git log` shows for a merge by default.
 */
const LOG_ARGS = [
  "log",
  "--reverse",
  "--first-parent",
  "--diff-merges=first-parent",
  "--numstat",
  "-z",
  "--no-renames",
  "--format=%x00%H%x00%ct%x00%s",
] as const;

/**
 * Every path that needs a building: touched by a commit in range, or deleted
 * without being committed. Both are absent from a city built from the current
 * tree, and a column with nowhere to stand is simply not drawn.
 */
export function ghostPathsOf(
  steps: ReadonlyArray<DiffOverlayStep>,
  deletedPaths: ReadonlyArray<string> = [],
): Array<string> {
  const paths = new Set<string>(deletedPaths.filter((path) => path !== ""));
  for (const step of steps) {
    for (const file of step.files) if (file.path !== "") paths.add(file.path);
  }
  return [...paths];
}

/**
 * Parse `git log --numstat -z --format=%x00%H%x00%ct%x00%s`.
 *
 * `-z` terminates every field with a NUL, so the leading `%x00` of the format
 * makes each commit header arrive as an *empty* field followed by sha, epoch,
 * and subject. Anything else is a numstat record. That is the whole grammar —
 * and it survives the awkward cases, because the three header fields are read
 * positionally: an empty subject cannot be mistaken for the next header, and a
 * commit with no diff simply has no records between two headers.
 */
export function parseCommitLog(stdout: string): Array<DiffOverlayStep> {
  const fields = stdout.split("\0");
  const steps: Array<DiffOverlayStep> = [];
  let current: Array<DiffOverlayFile> | null = null;
  let index = 0;

  while (index < fields.length) {
    // git prints a newline after a header that has records; it lands on the
    // front of the first record rather than on the header.
    const field = stripLeadingNewlines(fields[index] ?? "");
    if (field === "") {
      if (index + 3 >= fields.length) break;
      const files: Array<DiffOverlayFile> = [];
      steps.push({
        id: fields[index + 1] ?? "",
        kind: "commit",
        title: fields[index + 3] ?? "",
        committedAt: isoFromEpochSeconds(fields[index + 2] ?? ""),
        files,
      });
      current = files;
      index += 4;
      continue;
    }
    index += consumeNumstatRecord(fields, index, field, current);
  }
  return steps;
}

function isoFromEpochSeconds(value: string): string {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) return "";
  return DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));
}

function workingTreeOnlyRange() {
  return { kind: "working-tree", baseRef: null, headRef: null } as const;
}

function emptyCitymap(root: string, generatedAt: string): Citymap {
  return {
    version: CITYMAP_VERSION,
    repo: { root, dirty: false, generatedAt },
    files: [],
    dirs: [],
    layout: { algorithm: "unavailable", weight: "none" },
  };
}
