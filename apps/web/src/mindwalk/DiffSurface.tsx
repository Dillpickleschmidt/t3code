import type { DiffOverlay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useMemo, useRef, useState } from "react";

import { TooltipProvider } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { cssVariables, paletteFor, resolveScenePalette } from "./palette";
import type { ScenePalette } from "./palette";
import type { FilePlayback } from "./playback/reducer";
import { CityScene } from "./scene/CityScene";
import { diffColumns, type FileChurn } from "./scene/columns";
import type { CityFile, CityMap } from "./types";
import { CommitScrubber } from "./ui/CommitScrubber";
import "./surface.css";

/**
 * 3D Diff: a range of commits played over the repository as stacked terrain.
 *
 * A sibling of the 2D Diff panel rather than of 3D Watch Agent — it is keyed by
 * working directory, not by thread, and it steps *commits* rather than an
 * agent's tool calls. What it shares with Watch Agent is the stage: the same
 * `CityScene`, the same citymap, the same palette. All that differs is the
 * height policy, which is why adding it needed no second scene — see
 * `./scene/columns`.
 *
 * The window is whatever the 2D panel's Automatic base resolves to, because
 * the server asks that panel's own service for it. There is deliberately no
 * base-ref picker in this first cut.
 */
export default function DiffSurface({ cwd }: { cwd: string }) {
  const { resolvedTheme } = useTheme();
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

  const [overlay, setOverlay] = useState<DiffOverlay | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();

  useEffect(() => {
    setOverlay(undefined);
    setError(undefined);
    setSelectedPath(undefined);
    setPlaying(false);
    let cancelled = false;
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.mindwalk.diffOverlay({ query: { cwd }, headers: {} })),
      ),
    ).then(
      (result) => {
        if (cancelled) return;
        setOverlay(result);
        // Open on the finished state, as Watch Agent does: the last frame is
        // what you came to look at, and scrubbing back replays from there.
        setStepIndex(Math.max(0, result.steps.length - 1));
      },
      (cause: unknown) => {
        if (!cancelled) setError(String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const city = overlay?.citymap as CityMap | undefined;
  const steps = overlay?.steps ?? [];
  const step = Math.min(stepIndex, Math.max(0, steps.length - 1));

  // One step, one commit — steps do not accumulate. This is the same reading
  // as every diff view in T3 and in an ordinary git client: "what did this
  // commit change", not "what has changed so far". Scrubbing walks the branch
  // commit by commit rather than watching a pile grow.
  const churnByPath = useMemo(() => {
    const totals = new Map<string, FileChurn>();
    for (const file of steps[step]?.files ?? []) {
      totals.set(file.path, { additions: file.additions, deletions: file.deletions });
    }
    return totals;
  }, [steps, step]);

  // The scale is the whole range's tallest column, not this step's, so height
  // stays comparable as you scrub: a quiet commit reads as quiet instead of
  // being stretched to fill the frame.
  const fullHeightChurn = useMemo(() => {
    let peak = 0;
    for (const entry of steps) {
      for (const file of entry.files) peak = Math.max(peak, file.additions + file.deletions);
    }
    return peak;
  }, [steps]);

  const columns = useMemo(
    () => (city ? diffColumns(city, churnByPath, fullHeightChurn, scenePalette) : []),
    [city, churnByPath, fullHeightChurn, scenePalette],
  );

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const churn of churnByPath.values()) {
      additions += churn.additions;
      deletions += churn.deletions;
    }
    return { additions, deletions, files: churnByPath.size };
  }, [churnByPath]);

  const hoverMeta = useMemo(
    () => (file: CityFile) => {
      const churn = churnByPath.get(file.path);
      if (!churn) return "unchanged";
      if (churn.additions === 0 && churn.deletions === 0) return "changed · no line count";
      return `+${churn.additions} −${churn.deletions}`;
    },
    [churnByPath],
  );

  const selection = selectedPath === undefined ? {} : { selectedPath };
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
                palette={scenePalette}
                {...selection}
              />
              <div className="pointer-events-none absolute inset-0 p-5 @max-[900px]:px-4 @max-[900px]:py-3.5">
                <div className="pointer-events-auto min-w-0">
                  {/* The step's own title, because the terrain is one commit
                      rather than a running total — without it there is nothing
                      on screen saying which commit you are standing in. */}
                  <div className="truncate font-semibold text-foreground text-xl tracking-tight @max-[900px]:text-lg">
                    {steps[step]?.title || basename(city.repo.root)}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                    <span>{basename(city.repo.root)}</span>
                    <span>{rangeLabel(overlay)}</span>
                    <span>
                      {totals.files} file{totals.files === 1 ? "" : "s"}
                    </span>
                    <span className="text-[var(--mw-diff-added)]">+{totals.additions}</span>
                    <span className="text-[var(--mw-diff-removed)]">−{totals.deletions}</span>
                  </div>
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

        {overlay ? (
          <CommitScrubber
            steps={steps}
            rangeLabel={rangeLabel(overlay)}
            currentStep={step}
            onChange={setStepIndex}
            playing={playing}
            onPlayingChange={setPlaying}
          />
        ) : null}
      </div>
    </TooltipProvider>
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
      return `last ${overlay.steps.filter((step) => step.kind === "commit").length} commits`;
    case "working-tree":
      return "working tree";
  }
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}
