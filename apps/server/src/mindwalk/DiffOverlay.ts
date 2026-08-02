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
import type {
  Citymap,
  DiffOverlay,
  DiffOverlayFile,
  DiffOverlayRange,
  DiffOverlayStep,
} from "@t3tools/contracts";
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
/** Untracked files diffed at once, matching `readUntrackedReviewDiffs`. */
const UNTRACKED_CONCURRENCY = 4;

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
    operation: Schema.Literals([
      "log",
      "logTruncated",
      "aggregate",
      "aggregateTruncated",
      "workingTree",
      "workingTreeTruncated",
      "untracked",
      "untrackedTruncated",
    ]),
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

    const { range, steps, aggregate } = driver
      ? yield* readSteps(
          root,
          makeRunGit(root, driver, ignoreWhitespace),
          branchSource?.baseRef ?? null,
          branchSource?.headRef ?? null,
        )
      : {
          range: workingTreeOnlyRange(),
          steps: [] as ReadonlyArray<DiffOverlayStep>,
          aggregate: null,
        };

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
    // The aggregate is asked separately rather than assumed to be covered by
    // the steps: it runs with rename detection where they run `--no-renames`,
    // so the two do not report the same path set over a range with a rename.
    const citymap = citymapFailed ? base : withGhosts(base, ghostPathsOf(steps, aggregate ?? []));

    yield* Effect.annotateCurrentSpan({
      "diffOverlay.range": range.kind,
      "diffOverlay.step_count": steps.length,
      "diffOverlay.aggregate_file_count": aggregate?.length ?? -1,
    });
    // The root, not the request: the payload describes that repository, and
    // echoing back a subdirectory the citymap does not cover would be a lie
    // the client would key its cache on.
    return { cwd: root, generatedAt, range, steps, aggregate, citymap } satisfies DiffOverlay;
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

    const working = yield* readWorkingTreeStep(cwd, runGit);
    return {
      range: {
        kind,
        // The fallback's window is a commit count, so naming a base ref it did
        // not use would be a lie the client would then render.
        baseRef: kind === "branch-range" ? baseRef : null,
        headRef: kind === "branch-range" ? headRef : null,
      },
      steps: working ? [...commits, working] : commits,
      // Netted over the same window the steps cover, not over `baseRef`
      // blindly: when the branch has not diverged, `baseRef..HEAD` is empty and
      // the steps fall back to recent commits, so netting the base would hand
      // the scrubber an aggregate that covers none of the commits under it.
      // Where the 2D panel has anything to show at all, this is the identical
      // range and therefore the identical numbers.
      aggregate: yield* readAggregate(cwd, runGit, kind, baseRef, commits),
    } as const;
  });

  /**
   * The window as one net frame. Deliberately a second git call rather than a
   * fold of the steps: they carry churn, and a net diff is a different number
   * on any file a range touches more than once.
   *
   * The revision expression is the one thing here worth reading twice.
   * `branch-range` uses `<base>...HEAD`, character for character what the 2D
   * panel's branch source runs, so the two agree by construction rather than by
   * inspection. The `recent-commits` fallback has no base ref — its window is a
   * commit count — so it nets from the parent of its oldest step, which is the
   * same window the scrubber walks. Both are equivalent to the two-endpoint
   * form there, since the parent is an ancestor of HEAD; the three-dot form is
   * only load-bearing in the branch case.
   *
   * `--no-renames` is *not* passed, unlike everywhere else in this module. See
   * the `aggregate` field's note in the contract: this frame is read against
   * the 2D panel's numbers, so it asks the 2D panel's question.
   */
  const readAggregate = Effect.fn("DiffOverlay.readAggregate")(function* (
    cwd: string,
    runGit: RunGit,
    kind: DiffOverlayRange["kind"],
    baseRef: string | null,
    commits: ReadonlyArray<DiffOverlayStep>,
  ) {
    const revisions =
      kind === "branch-range" && baseRef
        ? [`${baseRef}...HEAD`]
        : kind === "recent-commits" && commits[0]
          ? [`${commits[0].id}^`, "HEAD"]
          : null;
    if (!revisions) return null;

    const result = yield* runGit("aggregate", ["diff", "--numstat", "-z", ...revisions, "--"]);
    // Non-zero is an outcome to read, as it is for `readLog`. The reachable
    // case is a `recent-commits` window that reaches the repository's root
    // commit, whose `^` does not resolve — a repository with fewer commits
    // than the fallback window. No base to net from is not an error, and the
    // 2D panel shows an empty branch diff there too.
    if (result.exitCode !== 0) return null;
    if (result.stdoutTruncated) {
      return yield* Effect.fail(new DiffOverlayError({ cwd, operation: "aggregateTruncated" }));
    }
    return parseNumstat(result.stdout);
  });

  /**
   * Everything uncommitted, as one final step. Deliberately the same universe
   * as the 2D panel's working-tree source: tracked changes against `HEAD`
   * (staged *and* unstaged) plus untracked-but-not-ignored files, which is
   * also the file set `listWorkspaceFiles` gives the citymap.
   */
  const readWorkingTreeStep = Effect.fn("DiffOverlay.readWorkingTreeStep")(function* (
    cwd: string,
    runGit: RunGit,
  ) {
    // Truncation is failure, not a short answer. Both of these list one entry
    // per file, so a tree big enough to hit the output cap would come back as
    // a prefix — and the final frame would quietly omit files rather than say
    // it could not read them all. `readLog` refuses the same way.
    const tracked = yield* runGit("workingTree", [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "HEAD",
      "--",
    ]);
    if (tracked.stdoutTruncated) {
      return yield* Effect.fail(new DiffOverlayError({ cwd, operation: "workingTreeTruncated" }));
    }
    const untrackedList = yield* runGit("untracked", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (untrackedList.stdoutTruncated) {
      return yield* Effect.fail(new DiffOverlayError({ cwd, operation: "untrackedTruncated" }));
    }
    const untrackedPaths =
      untrackedList.exitCode === 0
        ? untrackedList.stdout.split("\0").filter((entry) => entry.length > 0)
        : [];
    // `--no-index` exits 1 whenever the files differ, which is every time.
    const untracked = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        runGit("untracked", [
          "diff",
          "--numstat",
          "-z",
          "--no-index",
          "--",
          "/dev/null",
          relativePath,
        ]).pipe(Effect.map((result) => parseNumstat(result.stdout))),
      { concurrency: UNTRACKED_CONCURRENCY },
    );

    const files = [
      ...(tracked.exitCode === 0 ? parseNumstat(tracked.stdout) : []),
      ...untracked.flat(),
    ];
    if (files.length === 0) return null;
    return {
      id: "working-tree",
      kind: "working-tree",
      title: "Uncommitted changes",
      committedAt: DateTime.formatIso(yield* DateTime.now),
      files,
    } satisfies DiffOverlayStep;
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
 * Paths any frame of the overlay touched, for the citymap to raise ghosts
 * against — the steps and the aggregate alike, since the two run git with
 * different rename settings and so do not always name the same files.
 */
export function ghostPathsOf(
  steps: ReadonlyArray<DiffOverlayStep>,
  aggregate: ReadonlyArray<DiffOverlayFile> = [],
): Array<string> {
  const paths = new Set<string>();
  for (const file of [...steps.flatMap((step) => step.files), ...aggregate]) {
    if (file.path !== "") paths.add(file.path);
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
    index += consumeRecord(fields, index, field, current);
  }
  return steps;
}

/** Parse a bare `git diff --numstat -z`, which has no commit headers. */
export function parseNumstat(stdout: string): Array<DiffOverlayFile> {
  const fields = stdout.split("\0");
  const files: Array<DiffOverlayFile> = [];
  let index = 0;
  while (index < fields.length) {
    const field = stripLeadingNewlines(fields[index] ?? "");
    if (field === "") {
      index += 1;
      continue;
    }
    index += consumeRecord(fields, index, field, files);
  }
  return files;
}

/**
 * Read one `additions \t deletions \t path` record, returning how many fields
 * it spanned. An empty path means git split the name across the next two
 * fields (old then new) — `--no-index` does this for `/dev/null` against a
 * real file even with `--no-renames`, so it is not merely a rename case.
 */
function consumeRecord(
  fields: ReadonlyArray<string>,
  index: number,
  field: string,
  into: Array<DiffOverlayFile> | null,
): number {
  const [additions, deletions, name] = field.split("\t");
  if (additions === undefined || deletions === undefined || name === undefined) return 1;
  const width = name === "" ? 3 : 1;
  const path = name === "" ? (fields[index + 2] ?? "") : name;
  if (into !== null && path !== "") {
    // A binary file reports "-" for both counts; it has no lines, so it gets a
    // building and no height rather than being dropped from the step.
    into.push({
      path,
      additions: parseCount(additions),
      deletions: parseCount(deletions),
    });
  }
  return width;
}

function parseCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function stripLeadingNewlines(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "\n") start += 1;
  return start === 0 ? value : value.slice(start);
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
