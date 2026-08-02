import type { DiffOverlay, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { resolveDiffScope } from "../diffScope";
import { useCheckpointDiff } from "../lib/checkpointDiffState";
import { getRenderablePatch, resolveFileDiffPath } from "../lib/diffRendering";
import { useClientSettings } from "../hooks/useSettings";
import { selectSource, useReviewDiffPreview } from "../hooks/useReviewDiffPreview";
import { serverEnvironment } from "../state/server";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useThread } from "../state/entities";
import { formatShortTimestamp } from "../timestampFormat";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { cssVariables, paletteFor, resolveScenePalette } from "./palette";
import type { ScenePalette } from "./palette";
import type { FilePlayback } from "./playback/reducer";
import { CityScene } from "./scene/CityScene";
import { diffColumns, diffHeight, type FileChurn } from "./scene/columns";
import type { CityFile, CityMap } from "./types";
import { CommitScrubber } from "./ui/CommitScrubber";
import "./surface.css";

/**
 * 3D Diff: a range of changes played over the repository as stacked terrain.
 *
 * It draws the same four scopes the 2D Diff panel offers, out of the same
 * stored selection, because it is a different renderer of that panel's query
 * rather than a surface of its own. Two of those scopes are repository-shaped
 * (working tree, branch) and two are thread-shaped (latest turn, a named
 * turn), which is why it takes a thread ref alongside a working directory —
 * the same mixture the 2D panel is, hosted the same way.
 *
 * What it does *not* do is keep its own copy of any of that. The scope comes
 * from `diffPanelStore`, whitespace and timestamp handling come from T3's
 * settings, and the turn scopes read the very query the 2D panel reads. The
 * one piece of state it owns is the commit drill-down, because no 2D
 * counterpart has one.
 */
export default function DiffSurface({
  cwd,
  threadRef,
}: {
  cwd: string;
  /** Null when the surface is open without a thread — turn scopes disable. */
  threadRef: ScopedThreadRef | null;
}) {
  const { resolvedTheme } = useTheme();
  // T3's own settings, not defaults of ours: the 2D panel sends whitespace on
  // every request and formats every turn's date with `timestampFormat`, and
  // two diff surfaces disagreeing about either would make both untrustworthy.
  const { diffIgnoreWhitespace, timestampFormat } = useClientSettings();
  const palette = useMemo(() => paletteFor(resolvedTheme), [resolvedTheme]);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [resolved, setResolved] = useState<ScenePalette | undefined>();

  // The stage's colours are read off the live theme rather than declared —
  // see `resolveScenePalette`. Deferred a frame because `useTheme` applies the
  // `.dark` class from its own effect, and effect order is not guaranteed.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const host = surfaceRef.current;
      if (host) setResolved(resolveScenePalette(host, resolvedTheme));
    });
    return () => cancelAnimationFrame(frame);
  }, [resolvedTheme]);

  const scenePalette = resolved ?? palette.scene;

  // ------------------------------------------------------------ the scope
  //
  // Read reactively rather than at mount: this surface is keyed by `cwd`
  // (`ChatView`), so it does not remount when the thread changes and would
  // otherwise be left drawing the scope of a thread it is no longer on.
  const thread = useThread(threadRef);
  const { orderedTurnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(thread);
  const selection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const scope = resolveDiffScope(
    selection,
    orderedTurnDiffSummaries,
    inferredCheckpointTurnCountByTurnId,
  );
  const hasTurns = orderedTurnDiffSummaries.length > 0;

  // Pointing at a turn the thread no longer has strands the store for the 2D
  // panel too, so the surface reconciles rather than only tolerating it.
  useEffect(() => {
    if (!threadRef || selection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      threadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [selection, orderedTurnDiffSummaries, threadRef]);

  // The two repository scopes are this query, not a second opinion about it.
  // Same hook the 2D panel calls, same refs, same whitespace, same
  // workspace-boundary retry — so "Branch changes" cannot mean one thing here
  // and another over there, and neither can the numbers under it.
  // `includeFileStats` because the terrain places every changed file: a file
  // past the patch cap is a building that never appears, where in the 2D panel
  // it is a row below a banner that says the list is incomplete.
  const reviewPreview = useReviewDiffPreview(threadRef, cwd, {
    ignoreWhitespace: diffIgnoreWhitespace,
    enabled: scope.kind !== "turn",
    includeFileStats: true,
  });
  // The boundary retry's target, from the server's own config — NOT from the
  // review preview's answer, which is disabled on turn scopes. Reading it off
  // that query made the citymap fetch fail on exactly the scopes that don't
  // run it, and re-fetch on every scope switch besides.
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(threadRef?.environmentId ?? null),
  );
  const environmentCwd = serverConfig?.cwd;

  const [overlay, setOverlay] = useState<DiffOverlay | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [playing, setPlaying] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  /**
   * Which commit of the branch range the stage is standing in, or `null` for
   * the whole range netted — the frame Branch changes opens on. The scrubber
   * is a drill-down of that scope, so this is the surface's own state: no 2D
   * entry has a position within a range.
   */
  const [drillStep, setDrillStep] = useState<number | null>(null);

  useEffect(() => {
    setOverlay(undefined);
    setError(undefined);
    setSelectedPath(undefined);
    setPlaying(false);
    let cancelled = false;

    const fetchAt = (at: string) =>
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.mindwalk.diffOverlay({
              query: { cwd: at, ignoreWhitespace: diffIgnoreWhitespace ? "true" : "false" },
              headers: {},
            }),
          ),
        ),
      );

    // The project's directory is not always inside the server's configured
    // workspace — a server started in a subdirectory of the repository it is
    // serving bounds itself to that subdirectory, which is what an ordinary
    // `vp run dev` produces. The 2D panel has always retried at the
    // environment's own cwd when that happens (`DiffPanel.tsx`), and every
    // reason this surface exists says it should behave the same: the whole
    // point is to be a different renderer of that panel's query, and a repo
    // view that dies where the panel beside it succeeds is not one.
    fetchAt(cwd)
      .catch((cause: unknown) => {
        if (!isCwdOutsideWorkspace(cause) || !environmentCwd || environmentCwd === cwd) {
          throw cause;
        }
        return fetchAt(environmentCwd);
      })
      .then(
        (result) => {
          if (cancelled) return;
          setOverlay(result);
          setDrillStep(null);
        },
        (cause: unknown) => {
          if (!cancelled) setError(String(cause));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [cwd, diffIgnoreWhitespace, environmentCwd]);

  // ------------------------------------------------------- the turn's diff
  //
  // The checkpoint *summary* on the thread cannot drive this. Its counts are
  // captured once, with `ignoreWhitespace: false` hardcoded
  // (`CheckpointReactor.ts`), so a user on T3's default — ignore-whitespace on
  // — would get a reformat rendered as towers here and as nothing in the 2D
  // panel's view of the same turn. That is the drift this surface was just
  // fixed for, so the turn scopes read the 2D panel's own query instead, on
  // the identical target so the two share one fetch rather than making two.
  const turnCount = scope.turnCount;
  const turnDiff = useCheckpointDiff(
    {
      environmentId: threadRef?.environmentId ?? null,
      threadId: threadRef?.threadId ?? null,
      fromTurnCount: turnCount === undefined ? null : Math.max(0, turnCount - 1),
      toTurnCount: turnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: scope.turn ? `turn:${scope.turn.turnId}` : null,
    },
    { enabled: scope.kind === "turn" && scope.turn !== undefined && turnCount !== undefined },
  );

  const turnChurn = useMemo(() => {
    const patch = getRenderablePatch(turnDiff.data?.diff, "mindwalk-diff3d");
    if (!patch || patch.kind !== "files") return null;
    const totals = new Map<string, FileChurn>();
    for (const file of patch.files) {
      // `a/`/`b/` stripped and repo-root-relative — the citymap's vocabulary,
      // and the same resolution the 2D panel lists files under.
      const path = resolveFileDiffPath(file);
      if (!path) continue;
      let additions = 0;
      let deletions = 0;
      for (const hunk of file.hunks) {
        additions += hunk.additionLines;
        deletions += hunk.deletionLines;
      }
      totals.set(path, { additions, deletions });
    }
    return totals;
  }, [turnDiff.data?.diff]);

  // ------------------------------------------------------------ the frame
  const commitSteps = overlay?.steps ?? [];
  const workingSource = selectSource(reviewPreview.sources, "unstaged");
  const branchSource = selectSource(reviewPreview.sources, "branch");

  // Scope changes clear the stage's own state. A column selected in one scope
  // is usually not even present in the next, and a drill-down position means
  // nothing outside the branch range that produced it.
  const scopeKey = scope.kind === "turn" ? `turn:${scope.turn?.turnId ?? "none"}` : scope.kind;
  useEffect(() => {
    setSelectedPath(undefined);
    setDrillStep(null);
    setPlaying(false);
  }, [scopeKey]);

  const frame = useMemo((): Frame => {
    switch (scope.kind) {
      case "unstaged":
        if (reviewPreview.error)
          return emptyFrame("Working tree", `Could not load this diff: ${reviewPreview.error}`);
        return workingSource && workingSource.files.length > 0
          ? frameOf("Uncommitted changes", workingSource.files, [workingSource.files])
          : emptyFrame("Uncommitted changes", "The working tree is clean.");
      case "turn": {
        if (!threadRef) return emptyFrame("Turn", "Open a thread to see its turns.");
        if (!scope.turn) return emptyFrame(scope.label, "This thread has no turn checkpoints yet.");
        if (turnDiff.error)
          return emptyFrame(scope.label, `Could not load this turn: ${turnDiff.error}`);
        if (!turnChurn) return emptyFrame(scope.label);
        return frameOf(scope.label, turnChurn, [turnChurn]);
      }
      default: {
        // Branch changes: the review preview's own branch source, drilled into
        // one commit at a time. Framing height spans the range and the whole
        // frame together, so the camera does not rescale as you step in and out.
        const spans = [...commitSteps.map((step) => step.files), branchSource?.files ?? []];
        if (drillStep !== null) {
          const step = commitSteps[Math.min(drillStep, commitSteps.length - 1)];
          return step
            ? frameOf(step.title, step.files, spans)
            : emptyFrame("Branch changes", "Nothing has changed in this range.");
        }
        if (reviewPreview.error)
          return emptyFrame("Branch changes", `Could not load this diff: ${reviewPreview.error}`);
        if (!branchSource) return emptyFrame("Branch changes");
        return branchSource.files.length > 0
          ? frameOf(
              overlay ? rangeLabel(overlay) : (branchSource.baseRef ?? "Branch changes"),
              branchSource.files,
              spans,
            )
          : emptyFrame(
              "Branch changes",
              branchSource.baseRef
                ? "Nothing has changed in this range."
                : "This branch has no base to compare against yet.",
            );
      }
    }
  }, [
    scope.kind,
    scope.label,
    scope.turn,
    threadRef,
    workingSource,
    branchSource,
    reviewPreview.error,
    turnChurn,
    turnDiff.error,
    commitSteps,
    overlay,
    drillStep,
  ]);

  const city = overlay?.citymap as CityMap | undefined;

  const columns = useMemo(
    () => (city ? diffColumns(city, frame.churnByPath, scenePalette) : []),
    [city, frame.churnByPath, scenePalette],
  );

  const tallestColumn = useMemo(() => diffHeight(frame.peakChurn), [frame.peakChurn]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const churn of frame.churnByPath.values()) {
      additions += churn.additions;
      deletions += churn.deletions;
    }
    return { additions, deletions, files: frame.churnByPath.size };
  }, [frame.churnByPath]);

  /**
   * Files this frame changed that the citymap has no building for.
   *
   * The standing rule is to check that two data sources agree on their
   * vocabulary rather than assume it, and this is that check made visible
   * instead of silent. It should read zero on the repository scopes, whose
   * deleted files the endpoint raises as ghosts. The turn scopes are the
   * honest exception: their ghosts would have to come from the same endpoint,
   * which is keyed by working directory and knows nothing about this thread,
   * so a file a turn *deleted* has nowhere to stand. Saying so beats drawing a
   * frame that quietly omits it.
   */
  const offMapFiles = useMemo(() => {
    if (!city || frame.churnByPath.size === 0) return 0;
    const onMap = new Set(city.files.map((file) => file.path));
    let missing = 0;
    for (const path of frame.churnByPath.keys()) if (!onMap.has(path)) missing += 1;
    return missing;
  }, [city, frame.churnByPath]);

  const hoverMeta = useMemo(
    () => (file: CityFile) => {
      const churn = frame.churnByPath.get(file.path);
      if (!churn) return "unchanged";
      if (churn.additions === 0 && churn.deletions === 0) return "changed · no line count";
      return `+${churn.additions} −${churn.deletions}`;
    },
    [frame.churnByPath],
  );

  const selectTurn = (turnId: (typeof orderedTurnDiffSummaries)[number]["turnId"]) => {
    if (!threadRef) return;
    useDiffPanelStore.getState().selectTurn(threadRef, turnId);
  };
  const selectGitScope = (next: "branch" | "unstaged") => {
    if (!threadRef) return;
    useDiffPanelStore.getState().selectGitScope(threadRef, next);
  };

  const selection3d = selectedPath === undefined ? {} : { selectedPath };
  const mapUnavailable = city !== undefined && city.files.length === 0;

  return (
    // `@container` makes the responsive rules key off this surface's own width,
    // not the viewport: it is a resizable panel, not a window.
    <TooltipProvider delay={0} closeDelay={0}>
      <div
        ref={surfaceRef}
        data-mindwalk-root=""
        className="@container relative flex h-full flex-col overflow-hidden bg-background"
        style={cssVariables(palette, scenePalette)}
      >
        <div className="relative min-h-0 flex-1">
          {overlay && city ? (
            <>
              <CityScene
                city={city}
                columns={columns}
                playback={NO_WALK}
                hoverMeta={hoverMeta}
                onSelect={setSelectedPath}
                playing={playing}
                tallestColumn={tallestColumn}
                palette={scenePalette}
                {...selection3d}
              />
              <div className="pointer-events-none absolute inset-0 p-5 @max-[900px]:px-4 @max-[900px]:py-3.5">
                <div className="pointer-events-auto min-w-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="mb-1.5 inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted/70 px-2 font-medium text-foreground text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Diff scope: ${scope.label}`}
                      disabled={!threadRef}
                    >
                      <span className="truncate">{scope.label}</span>
                      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-60">
                      <DropdownMenuItem
                        className={scope.kind === "unstaged" ? "bg-foreground/[0.08]" : undefined}
                        onClick={() => selectGitScope("unstaged")}
                      >
                        <span>Working tree</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={scope.kind === "branch" ? "bg-foreground/[0.08]" : undefined}
                        onClick={() => selectGitScope("branch")}
                      >
                        <span>Branch changes</span>
                      </DropdownMenuItem>
                      <TurnEntryTooltip enabled={hasTurns}>
                        <DropdownMenuItem
                          disabled={!hasTurns}
                          className={
                            scope.kind === "turn" && scope.isLatestTurn
                              ? "bg-foreground/[0.08]"
                              : undefined
                          }
                          onClick={() => {
                            const latest = orderedTurnDiffSummaries[0];
                            if (latest) selectTurn(latest.turnId);
                          }}
                        >
                          <span>Latest turn</span>
                        </DropdownMenuItem>
                      </TurnEntryTooltip>
                      {hasTurns ? (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-64">
                            {orderedTurnDiffSummaries.map((summary) => {
                              const count =
                                summary.checkpointTurnCount ??
                                inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                                "?";
                              return (
                                <DropdownMenuItem
                                  key={summary.turnId}
                                  className={
                                    summary.turnId === scope.turn?.turnId
                                      ? "bg-foreground/[0.08]"
                                      : undefined
                                  }
                                  onClick={() => selectTurn(summary.turnId)}
                                >
                                  <span>Turn {count}</span>
                                  <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                                    {formatShortTimestamp(summary.completedAt, timestampFormat)}
                                  </span>
                                </DropdownMenuItem>
                              );
                            })}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      ) : (
                        <TurnEntryTooltip enabled={false}>
                          <DropdownMenuItem disabled>
                            <span>Turn</span>
                          </DropdownMenuItem>
                        </TurnEntryTooltip>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* The frame's own title, because the terrain is one scope's
                      answer rather than the repository's — without it there is
                      nothing on screen saying what you are standing in. */}
                  <div className="truncate font-semibold text-foreground text-xl tracking-tight @max-[900px]:text-lg">
                    {frame.title || basename(city.repo.root)}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-muted-foreground text-xs">
                    <span>{basename(city.repo.root)}</span>
                    <span>{rangeLabel(overlay)}</span>
                    <span>
                      {totals.files} file{totals.files === 1 ? "" : "s"}
                    </span>
                    <span className="text-[var(--mw-diff-added)]">+{totals.additions}</span>
                    <span className="text-[var(--mw-diff-removed)]">−{totals.deletions}</span>
                    {offMapFiles > 0 ? (
                      <span className="text-muted-foreground/70">{offMapFiles} not on the map</span>
                    ) : null}
                  </div>
                  {frame.notice ? (
                    <div className="mt-1 text-muted-foreground text-xs">{frame.notice}</div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              {error ? `Could not load this repository's diff: ${error}` : "Building the map…"}
            </div>
          )}

          {mapUnavailable ? (
            <div className="mindwalk-glass absolute top-4 right-4 z-40 rounded-[var(--control-radius)] border border-border px-2.5 py-1.5 text-muted-foreground text-xs">
              No repository map for this workspace.
            </div>
          ) : null}
        </div>

        {/* One scope has a position within it; the other three are single
            frames, and a scrubber under them would be three dead controls. */}
        {overlay && scope.kind === "branch" ? (
          <CommitScrubber
            timestampFormat={timestampFormat}
            steps={commitSteps}
            rangeLabel={rangeLabel(overlay)}
            currentStep={drillStep}
            onChange={setDrillStep}
            playing={playing}
            onPlayingChange={setPlaying}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/**
 * The endpoint answers a cwd it may not read the same as one that is not
 * there, deliberately, so this is the tag to match rather than a message.
 */
function isCwdOutsideWorkspace(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { _tag?: unknown })._tag === "EnvironmentResourceNotFoundError" &&
    (cause as { reason?: unknown }).reason === "cwd_not_found"
  );
}

/** What one scope puts on the stage. */
interface Frame {
  readonly title: string;
  readonly churnByPath: ReadonlyMap<string, FileChurn>;
  /**
   * The busiest file anywhere this scope can reach, not just in this frame.
   * Taking it from the frame alone would zoom the stage in and out as you
   * step between a quiet commit and a busy one.
   */
  readonly peakChurn: number;
  /** Why there is nothing to draw, when there is nothing to draw. */
  readonly notice?: string;
}

/** What every source of a frame agrees to look like: a path and two counts. */
interface FileLineCount {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** A frame's files, however the scope that produced them happened to hold them. */
type ChurnSpan = ReadonlyArray<FileLineCount> | ReadonlyMap<string, FileChurn>;

function churnMapOf(files: ChurnSpan): ReadonlyMap<string, FileChurn> {
  if (files instanceof Map) return files;
  return new Map(
    (files as ReadonlyArray<FileLineCount>).map((file) => [
      file.path,
      { additions: file.additions, deletions: file.deletions },
    ]),
  );
}

function frameOf(title: string, files: ChurnSpan, framingSpans: ReadonlyArray<ChurnSpan>): Frame {
  let peakChurn = 0;
  for (const span of framingSpans) {
    for (const churn of churnMapOf(span).values()) {
      peakChurn = Math.max(peakChurn, churn.additions + churn.deletions);
    }
  }
  return { title, churnByPath: churnMapOf(files), peakChurn };
}

const NO_FILES: ReadonlyMap<string, FileChurn> = new Map();

/** Nothing to draw, and — unless the scope is still loading — why. */
function emptyFrame(title: string, notice?: string): Frame {
  return { title, churnByPath: NO_FILES, peakChurn: 0, ...(notice ? { notice } : {}) };
}

/**
 * Turn scopes disable rather than disappear when there is nothing behind them,
 * with the reason on hover — the same choice the surface picker makes for the
 * cards it cannot offer. A disabled item does not take pointer events, so the
 * tooltip hangs off a wrapper rather than the item.
 */
function TurnEntryTooltip({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  if (enabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{children}</TooltipTrigger>
      <TooltipPopup side="right">This thread has no turn checkpoints to show yet.</TooltipPopup>
    </Tooltip>
  );
}

/**
 * There is no walk on this surface, and an empty playback is how you say so:
 * `recentTargets` is empty, so the scene hides the firefly and clears the
 * trail on its own with no diff-specific gating.
 */
const NO_WALK: FilePlayback = {
  touchByFile: new Map(),
  touchByPath: new Map(),
  visitsByFile: new Map(),
  historyByPath: new Map(),
  recentTargets: [],
};

/**
 * `recent-commits` reports a null `baseRef` on purpose — the window is a commit
 * count, not a ref — so it has to be labelled from the step count instead.
 */
function rangeLabel(overlay: DiffOverlay): string {
  const head = overlay.range.headRef ?? "HEAD";
  switch (overlay.range.kind) {
    case "branch-range":
      return `${overlay.range.baseRef ?? "base"} → ${head}`;
    case "recent-commits":
      return `last ${overlay.steps.length} commits`;
    case "working-tree":
      return "working tree";
  }
}

// Both separators, as `filePathDisplay.ts` does. The repo-relative paths
// elsewhere in this surface are git's, and always use `/`; this one is an
// absolute filesystem path from the server, so on Windows the whole of
// `C:\Users\dev\t3code` would otherwise become the heading.
function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
}
