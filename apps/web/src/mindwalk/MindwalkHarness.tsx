import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useMemo, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { PlaybackEngine } from "./playback/reducer";
import { CityScene } from "./scene/CityScene";
import { TreeScene } from "./scene/TreeScene";
import type { CityMap } from "./types";
import "./harness.css";

type View = "tree" | "terrain";

/**
 * Throwaway harness proving the verbatim-ported mindwalk scenes render a T3
 * citymap. Static-map baseline only: no trace, so playback stays empty and
 * CityScene runs in `locHeights` mode — the equivalent of mindwalk's `?map=1`.
 * The real surface (playback deck, HUD, restyle) is later map work.
 */
export default function MindwalkHarness({ threadId }: { threadId: string }) {
  const [city, setCity] = useState<CityMap | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<View>("terrain");
  const [selectedPath, setSelectedPath] = useState<string | undefined>();

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setCity(undefined);
    setError(undefined);
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.citymap.threadCitymap({
            params: { threadId: threadId as ThreadId },
            headers: {},
          }),
        ),
      ),
    ).then(
      // The wire shape is byte-identical to mindwalk's CityMap by design (see
      // packages/contracts/src/citymap.ts); the cast only drops readonly.
      (map) => {
        if (!cancelled) setCity(map as unknown as CityMap);
      },
      (cause: unknown) => {
        if (!cancelled) setError(String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const playback = useMemo(() => new PlaybackEngine(undefined, city).snapshotAt(-1), [city]);
  const selection = selectedPath === undefined ? {} : { selectedPath };

  return (
    <div className="mindwalk-harness bg-[#12151c]">
      {city ? (
        view === "tree" ? (
          <TreeScene city={city} playback={playback} onSelect={setSelectedPath} {...selection} />
        ) : (
          <CityScene
            city={city}
            playback={playback}
            onSelect={setSelectedPath}
            locHeights
            {...selection}
          />
        )
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-white/60">
          {error
            ? `Citymap failed: ${error}`
            : threadId
              ? "Building the map…"
              : "Pass ?threadId=<id> to load a citymap."}
        </div>
      )}
      <div className="absolute top-3 left-3 z-40 flex gap-1 rounded-md bg-black/50 p-1 text-xs text-white">
        {(["terrain", "tree"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setView(candidate)}
            className={`rounded px-2 py-1 ${view === candidate ? "bg-white/20" : "hover:bg-white/10"}`}
          >
            {candidate}
          </button>
        ))}
      </div>
    </div>
  );
}
