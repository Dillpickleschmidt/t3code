import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Crosshair, Mountain, TreePine } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TooltipProvider } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { cssVariables, paletteFor } from "./palette";
import { PlaybackEngine } from "./playback/reducer";
import { CityScene } from "./scene/CityScene";
import { TreeScene } from "./scene/TreeScene";
import type { CityMap, Trace } from "./types";
import { Dock, type PanelDescriptor } from "./ui/Dock";
import { Hud } from "./ui/Hud";
import { Inspector } from "./ui/Inspector";
import { Timeline } from "./ui/Timeline";
import { ViewPanel, type SceneView } from "./ui/ViewPanel";
import "./surface.css";

interface Snapshot {
  trace: Trace;
  city: CityMap;
}

/**
 * 3D Watch Agent: one thread's trace played back over its repository, as
 * mindwalk's firefly tree or attention terrain.
 *
 * The snapshot arrives over HTTP rather than the thread websocket — it is
 * hundreds of kilobytes gzipped and the citymap half wants sending once, not
 * once per activity.
 *
 * This file is the T3-side equivalent of mindwalk's `App.tsx`, `state/`, and
 * `api/`, which are the parts of the port deliberately written rather than
 * copied. Everything under `ui/` is mindwalk's structure restyled onto T3's
 * tokens; everything under `scene/` and `playback/` is near-verbatim.
 */
export default function WatchAgentSurface({ threadId }: { threadId: ThreadId }) {
  const { resolvedTheme } = useTheme();
  const palette = useMemo(() => paletteFor(resolvedTheme), [resolvedTheme]);

  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<SceneView>("terrain");
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [currentSeq, setCurrentSeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [openSheet, setOpenSheet] = useState<string | null>(null);
  const [openPop, setOpenPop] = useState<string | null>(null);

  useEffect(() => {
    setSnapshot(undefined);
    setError(undefined);
    setSelectedPath(undefined);
    setPlaying(false);
    let cancelled = false;
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.mindwalk.threadSnapshot({
            params: { threadId },
            // `lens` is the per-agent slice; only the main lens is projected
            // today, and the server defaults to it when the parameter is absent.
            query: {},
            headers: {},
          }),
        ),
      ),
    ).then(
      // The wire shape is byte-identical to mindwalk's by design (see
      // packages/contracts/src/trace.ts); the cast only drops readonly.
      (result) => {
        if (cancelled) return;
        const next = result as unknown as { trace: Trace; citymap: CityMap };
        setSnapshot({ trace: next.trace, city: next.citymap });
        // Open at the end of the thread, as mindwalk does: the finished state is
        // what you came to look at, and scrubbing back replays from there.
        setCurrentSeq(Math.max(0, next.trace.events.length - 1));
      },
      (cause: unknown) => {
        if (!cancelled) setError(String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const trace = snapshot?.trace;
  const city = snapshot?.city;
  const total = trace?.events.length ?? 0;
  const seq = Math.min(currentSeq, Math.max(0, total - 1));

  const engine = useMemo(() => new PlaybackEngine(trace, city), [trace, city]);
  // A fresh wrapper per call: the engine hands out its live collections, so the
  // scenes re-read only when this identity changes.
  const playback = useMemo(() => engine.snapshotAt(seq), [engine, seq]);

  // live tallies for the HUD spectrum; touchByPath mirrors the backend stats scope
  const touchCounts = useMemo(() => {
    let edited = 0;
    let read = 0;
    let seen = 0;
    for (const touch of playback.touchByPath.values()) {
      if (touch === "edit") edited++;
      else if (touch === "read") read++;
      else seen++;
    }
    return { edited, read, seen };
  }, [playback]);

  const selectedFile = useMemo(
    () => (selectedPath ? city?.files.find((file) => file.path === selectedPath) : undefined),
    [city, selectedPath],
  );

  const churn = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of trace?.events ?? []) {
      for (const target of event.targets) {
        if (target.touch === "edit" && target.path) {
          counts.set(target.path, (counts.get(target.path) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .filter(([, edits]) => edits >= 3)
      .map(([path, edits]) => ({ path, edits }))
      .sort((a, b) => b.edits - a.edits || (a.path < b.path ? -1 : 1));
  }, [trace]);

  const viewNote =
    view === "tree"
      ? trace
        ? "glow ∝ revisits"
        : "static map"
      : trace
        ? "height ∝ depth × revisits"
        : "height ∝ lines";

  // selecting a file from anywhere opens the inspector on it, as upstream does
  const selectFile = useCallback((path?: string) => {
    setSelectedPath(path);
    if (path) setOpenSheet("inspect");
  }, []);

  const togglePanel = useCallback((panel: PanelDescriptor) => {
    if (panel.presentation === "pop") setOpenPop((open) => (open === panel.id ? null : panel.id));
    else setOpenSheet((open) => (open === panel.id ? null : panel.id));
  }, []);

  const closePop = useCallback(() => setOpenPop(null), []);
  const closeSheet = useCallback(() => setOpenSheet(null), []);

  const panels: PanelDescriptor[] = [
    {
      id: "view",
      icon: view === "tree" ? TreePine : Mountain,
      hint: `Scene view: ${view} — click to change`,
      section: "scene",
      presentation: "pop",
      render: () => <ViewPanel view={view} onViewChange={setView} note={viewNote} />,
    },
    {
      id: "inspect",
      icon: Crosshair,
      hint: "Inspect the selected file",
      section: "session",
      presentation: "sheet",
      render: () => (
        <Inspector
          {...(selectedFile && { file: selectedFile })}
          {...(selectedFile &&
            playback.touchByPath.get(selectedFile.path) && {
              touch: playback.touchByPath.get(selectedFile.path)!,
            })}
          history={selectedFile ? (playback.historyByPath.get(selectedFile.path) ?? []) : []}
          onClose={closeSheet}
          onJumpTo={setCurrentSeq}
        />
      ),
    },
  ];

  const selection = selectedPath === undefined ? {} : { selectedPath };
  const sceneProps = {
    playback,
    onSelect: selectFile,
    playing,
    theme: resolvedTheme,
    ...selection,
  };
  const mapUnavailable = city !== undefined && city.files.length === 0;

  return (
    // `@container` makes the responsive rules below key off this surface's own
    // width. Mindwalk keyed them off the viewport because it owned the window;
    // here the surface is a resizable panel, so a viewport query would give a
    // maximized panel and a narrow one the same layout.
    <TooltipProvider delay={0} closeDelay={0}>
      <div
        className="@container relative flex h-full flex-col overflow-hidden bg-background"
        style={cssVariables(palette)}
      >
        <div className="relative min-h-0 flex-1">
          {snapshot && city ? (
            <>
              {view === "tree" ? (
                <TreeScene city={city} {...sceneProps} />
              ) : (
                <CityScene city={city} {...sceneProps} />
              )}
              <Hud
                {...(trace && { trace })}
                city={city}
                editedNow={touchCounts.edited}
                readNow={touchCounts.read}
                seenNow={touchCounts.seen}
                churn={churn}
                onSelectFile={selectFile}
              />
              <Dock
                panels={panels}
                openSheet={openSheet}
                openPop={openPop}
                onToggle={togglePanel}
                onClosePop={closePop}
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              {error ? `Could not load this thread's trace: ${error}` : "Building the map…"}
            </div>
          )}

          {mapUnavailable ? (
            <div className="mindwalk-glass absolute top-4 right-4 z-40 rounded-[--control-radius] border border-border px-2.5 py-1.5 text-muted-foreground text-xs">
              No repository map for this thread — timeline only.
            </div>
          ) : null}
        </div>

        {snapshot ? (
          <Timeline
            {...(trace && { trace })}
            currentSeq={seq}
            onChange={setCurrentSeq}
            playing={playing}
            onPlayingChange={setPlaying}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
