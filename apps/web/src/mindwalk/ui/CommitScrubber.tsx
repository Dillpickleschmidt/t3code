import type { DiffOverlayStep } from "@t3tools/contracts";
import { Pause, Play, RotateCcw, StepBack, StepForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";

interface CommitScrubberProps {
  steps: readonly DiffOverlayStep[];
  /** How the window was resolved, for the caption's right-hand label. */
  rangeLabel: string;
  currentStep: number;
  onChange: (step: number) => void;
  /** playback state lives with the surface, which also drives the scene's
   * frame loop — a scene must know it is playing to book continuous frames */
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
}

/** A commit is a bigger unit than a tool call, so it gets longer on screen. */
const TICK_MS = 900;

/**
 * The 3D Diff transport.
 *
 * A sibling of `Timeline` rather than a generalisation of it. The Timeline's
 * strip is an action histogram over a trace — buckets of tool calls, coloured
 * by what the agent was doing, with compaction and subagent marks above it —
 * and none of that vocabulary exists here. What survives is the shape: a
 * scrubbable strip whose bars are a legend for the stage behind them.
 *
 * So the bars are the commits themselves, one per step rather than bucketed:
 * a range is tens of commits where a trace is thousands of events, so every
 * bar is a real thing you can click rather than a slice of several. Each is
 * split green over red in the same proportion its terrain columns are, which
 * makes the strip answer "which commit did the work" at a glance.
 */
export function CommitScrubber({
  steps,
  rangeLabel,
  currentStep,
  onChange,
  playing,
  onPlayingChange,
}: CommitScrubberProps) {
  const total = steps.length;
  const max = Math.max(0, total - 1);
  const step = Math.min(currentStep, max);
  const current = steps[step];

  const seqRef = useRef(step);
  const maxRef = useRef(max);
  const playingRef = useRef(playing);
  seqRef.current = step;
  maxRef.current = max;
  playingRef.current = playing;

  useEffect(() => {
    if (!playing || total === 0) return;
    const timer = window.setInterval(() => {
      if (seqRef.current >= maxRef.current) {
        onPlayingChange(false);
        return;
      }
      onChange(seqRef.current + 1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing, total, onChange, onPlayingChange]);

  const togglePlay = useCallback(() => {
    if (!playingRef.current && seqRef.current >= maxRef.current) onChange(0);
    onPlayingChange(!playingRef.current);
  }, [onChange, onPlayingChange]);

  const nudge = useCallback(
    (delta: number) => {
      onChange(Math.min(maxRef.current, Math.max(0, seqRef.current + delta)));
    },
    [onChange],
  );

  const bars = useMemo(
    () =>
      steps.map((entry) => {
        let additions = 0;
        let deletions = 0;
        for (const file of entry.files) {
          additions += file.additions;
          deletions += file.deletions;
        }
        return { id: entry.id, additions, deletions, churn: additions + deletions };
      }),
    [steps],
  );
  const peak = useMemo(() => bars.reduce((acc, bar) => Math.max(acc, bar.churn), 1), [bars]);

  const locked = total === 0;
  const currentBar = bars[step];

  return (
    <footer className="flex flex-none flex-col gap-1.5 border-border border-t bg-card px-5 py-2.5 @max-[900px]:px-3">
      <div className="flex items-center gap-3">
        <div className="relative mr-2.5 h-[46px] min-w-0 flex-1">
          <div
            className="absolute inset-x-0 top-3 bottom-3 flex items-end gap-px border-border border-b"
            aria-hidden
          >
            {bars.map((bar, index) => {
              // the bar is the column stack laid flat: additions from the
              // bottom, deletions capping them, in the same proportion
              const height = 18 + (bar.churn / peak) * 82;
              const removedShare = bar.churn > 0 ? (bar.deletions / bar.churn) * 100 : 0;
              return (
                <span
                  key={bar.id}
                  className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-[1px] ${
                    index <= step ? "opacity-90" : "opacity-30"
                  }`}
                  style={{ height: `${height}%` }}
                >
                  <span
                    className="w-full bg-[var(--mw-diff-removed)]"
                    style={{ height: `${removedShare}%` }}
                  />
                  <span className="w-full flex-1 bg-[var(--mw-diff-added)]" />
                </span>
              );
            })}
          </div>
          {total > 0 ? (
            <div
              className="pointer-events-none absolute top-2.5 bottom-0 w-[1.5px] -translate-x-1/2 bg-foreground after:absolute after:bottom-[-2px] after:left-1/2 after:size-[5px] after:-translate-x-1/2 after:rotate-45 after:bg-foreground after:content-['']"
              style={{ left: `${(step / Math.max(max, 1)) * 100}%` }}
              aria-hidden
            />
          ) : null}
          <input
            className="absolute inset-x-0 top-2 bottom-0 m-0 w-full cursor-ew-resize opacity-0"
            type="range"
            min={0}
            max={max}
            value={step}
            disabled={locked}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            aria-label="Diff position"
            aria-valuetext={current ? `${stepWord(current)}: ${current.title}` : "empty"}
          />
        </div>

        {/* reserve the widest count so the ticking digits never resize the strip */}
        <div className="text-right @max-[900px]:hidden">
          <span
            className="block text-foreground text-sm tabular-nums tracking-wide"
            style={{ minWidth: `${String(Math.max(total, 1)).length * 2 + 3}ch` }}
          >
            {total > 0 ? `${step + 1} / ${total}` : "0 / 0"}
          </span>
          <span className="block text-xs text-muted-foreground/70 tabular-nums">
            {current ? day(current.committedAt) : "—"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <IconButton onClick={() => nudge(-1)} disabled={locked} label="Step back one commit">
            <StepBack />
          </IconButton>
          <Button
            size="icon-sm"
            className="rounded-full"
            onClick={togglePlay}
            disabled={locked}
            aria-label={playing ? "Pause playback" : "Play playback"}
          >
            {playing ? <Pause /> : <Play className="ml-0.5" />}
          </Button>
          <IconButton onClick={() => nudge(1)} disabled={locked} label="Step forward one commit">
            <StepForward />
          </IconButton>
          <IconButton
            onClick={() => onChange(0)}
            disabled={locked}
            label="Back to the first commit"
          >
            <RotateCcw />
          </IconButton>
        </div>
      </div>

      {/* caption: what the playhead is on, then what the window covers */}
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-sm">
          {current && currentBar ? (
            <>
              <span className="flex-none font-mono text-muted-foreground text-xs">
                {stepWord(current)}
              </span>
              <span className="flex-none tabular-nums text-[var(--mw-diff-added)] text-xs">
                +{currentBar.additions}
              </span>
              <span className="flex-none tabular-nums text-[var(--mw-diff-removed)] text-xs">
                −{currentBar.deletions}
              </span>
              <span className="truncate text-muted-foreground" title={current.title}>
                {current.title}
              </span>
            </>
          ) : (
            <span className="truncate text-muted-foreground">
              Nothing has changed in this range.
            </span>
          )}
        </div>
        <div className="flex-none text-xs text-muted-foreground/70 uppercase tracking-[0.07em] @max-[1180px]:hidden">
          {rangeLabel}
        </div>
      </div>
    </footer>
  );
}

/** The uncommitted step has no sha to show, and saying so is the point. */
function stepWord(step: DiffOverlayStep): string {
  return step.kind === "working-tree" ? "working tree" : step.id.slice(0, 7);
}

function day(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function IconButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </Button>
  );
}
