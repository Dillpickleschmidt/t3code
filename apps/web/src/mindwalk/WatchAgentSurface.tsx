import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Pause, Play, SkipBack } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { PlaybackEngine } from "./playback/reducer";
import { CityScene } from "./scene/CityScene";
import { TreeScene } from "./scene/TreeScene";
import type { CityMap, Trace } from "./types";
import "./surface.css";

type View = "tree" | "terrain";

interface Snapshot {
  trace: Trace;
  city: CityMap;
}

/** mindwalk's own transport cadence (`ui/Timeline.tsx`): one event every 340ms
 * at 1x, and higher speeds advance several events per tick rather than ticking
 * faster, so the render rate stays bounded. */
const BASE_TICK_MS = 340;
const SPEEDS = [1, 4, 16] as const;
type Speed = (typeof SPEEDS)[number];

/**
 * 3D Watch Agent: one thread's trace played back over its repository, as
 * mindwalk's firefly tree or attention terrain.
 *
 * The snapshot arrives over HTTP rather than the thread websocket — it is
 * hundreds of kilobytes gzipped and the citymap half wants sending once, not
 * once per activity. The scene chrome (HUD, inspector, full timeline) is a
 * separate port; this is the transport and the scenes.
 */
export default function WatchAgentSurface({ threadId }: { threadId: ThreadId }) {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<View>("terrain");
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [currentSeq, setCurrentSeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

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

  const total = snapshot?.trace.events.length ?? 0;
  const max = Math.max(0, total - 1);
  const seq = Math.min(currentSeq, max);

  // The timer reads position through refs so that ticking the playhead does not
  // tear the interval down and rebuild it on every event.
  const seqRef = useRef(seq);
  const maxRef = useRef(max);
  const playingRef = useRef(playing);
  seqRef.current = seq;
  maxRef.current = max;
  playingRef.current = playing;

  useEffect(() => {
    if (!playing || total === 0) return;
    const interval = Math.max(85, BASE_TICK_MS / speed);
    const step = Math.max(1, Math.round((speed * interval) / BASE_TICK_MS));
    const timer = window.setInterval(() => {
      if (seqRef.current >= maxRef.current) {
        setPlaying(false);
        return;
      }
      setCurrentSeq(Math.min(seqRef.current + step, maxRef.current));
    }, interval);
    return () => window.clearInterval(timer);
  }, [playing, speed, total]);

  // Pressing play at the end restarts, as mindwalk does, rather than sitting on
  // a finished timeline doing nothing.
  const togglePlay = useCallback(() => {
    if (!playingRef.current && seqRef.current >= maxRef.current) setCurrentSeq(0);
    setPlaying((wasPlaying) => !wasPlaying);
  }, []);

  const engine = useMemo(
    () => new PlaybackEngine(snapshot?.trace, snapshot?.city),
    [snapshot?.trace, snapshot?.city],
  );
  // A fresh wrapper per call: the engine hands out its live collections, so the
  // scenes re-read only when this identity changes.
  const playback = useMemo(() => engine.snapshotAt(seq), [engine, seq]);

  const event = snapshot?.trace.events[seq];
  const selection = selectedPath === undefined ? {} : { selectedPath };
  const mapUnavailable = snapshot !== undefined && snapshot.city.files.length === 0;

  return (
    <div className="mindwalk-surface bg-[#12151c]">
      {snapshot ? (
        view === "tree" ? (
          <TreeScene
            city={snapshot.city}
            playback={playback}
            onSelect={setSelectedPath}
            playing={playing}
            {...selection}
          />
        ) : (
          <CityScene
            city={snapshot.city}
            playback={playback}
            onSelect={setSelectedPath}
            playing={playing}
            {...selection}
          />
        )
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-white/60">
          {error ? `Could not load this thread's trace: ${error}` : "Building the map…"}
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

      {snapshot ? (
        <div className="absolute right-3 bottom-3 left-3 z-40 flex items-center gap-2 rounded-md bg-black/60 px-2 py-1.5 text-xs text-white">
          <button
            type="button"
            onClick={() => setCurrentSeq(0)}
            disabled={total === 0}
            className="rounded p-1 hover:bg-white/10 disabled:opacity-40"
            aria-label="Jump to the first event"
          >
            <SkipBack className="size-4" />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            disabled={total === 0}
            className="rounded p-1 hover:bg-white/10 disabled:opacity-40"
            aria-label={playing ? "Pause playback" : "Play playback"}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={max}
            value={seq}
            disabled={total === 0}
            onChange={(changeEvent) => setCurrentSeq(Number(changeEvent.target.value))}
            className="min-w-0 flex-1 accent-white disabled:opacity-40"
            aria-label="Playback position"
          />
          <button
            type="button"
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
            className="rounded px-1.5 py-1 font-mono hover:bg-white/10"
            aria-label="Cycle playback speed"
          >
            {speed}x
          </button>
          <span className="shrink-0 font-mono tabular-nums text-white/70">
            {total === 0 ? "no events" : `${seq + 1}/${total}`}
          </span>
          <span className="max-w-64 truncate text-white/70">{event?.summary ?? ""}</span>
        </div>
      ) : null}

      {mapUnavailable ? (
        <div className="absolute top-3 right-3 z-40 rounded-md bg-black/50 px-2 py-1 text-xs text-white/70">
          No repository map for this thread — timeline only.
        </div>
      ) : null}
    </div>
  );
}
