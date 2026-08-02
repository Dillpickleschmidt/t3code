import { Ellipsis, Pause, Play, RotateCcw, StepBack, StepForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TimestampFormat } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { sceneClock } from "./sceneClock";
import type { Action, Mark, Trace } from "../types";

interface TimelineProps {
  trace?: Trace;
  currentSeq: number;
  onChange: (seq: number) => void;
  onSubagentMark?: (seq: number) => void;
  /** playback state lives with the surface, which also drives the scenes'
   * frame loop — a scene must know it is playing to book continuous frames */
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /** T3's 12/24-hour preference, so this surface's clock matches chat's. */
  timestampFormat: TimestampFormat;
}

const BUCKETS = 160;
const BASE_TICK_MS = 340;
const SPEEDS = [1, 4, 16] as const;
type Speed = (typeof SPEEDS)[number];

interface Bucket {
  /** first event index in this slice — the bucket's identity, and its key */
  from: number;
  count: number;
  dominant: Action;
}

// marks that land on the same strip pixel collapse into one glyph; the title
// carries the count so dense sessions stay legible
interface MarkGroup {
  /** `type:slot` — unique by construction, so it doubles as the React key */
  key: string;
  type: Mark["type"];
  seq: number;
  pos: number;
  count: number;
  note?: string;
}

const MARK_SLOTS = 220;

const MARK_LABEL: Record<Mark["type"], string> = {
  compaction: "context compaction",
  "user-message": "user message",
  subagent: "subagent",
};

const STRIP_ACTIONS: Action[] = ["search", "read", "edit", "verify", "exec"];

/** Histogram and action-dot colors are `--mw-act-*`: the same values the scene
 * draws with, so the strip is a legend rather than a second palette. */
const ACTION_COLOR: Record<Action, string> = {
  search: "bg-[var(--mw-act-search)]",
  read: "bg-[var(--mw-act-read)]",
  edit: "bg-[var(--mw-act-edit)]",
  verify: "bg-[var(--mw-act-verify)]",
  exec: "bg-[var(--mw-act-exec)]",
  other: "bg-[var(--mw-act-other)]",
};

export function Timeline({
  trace,
  currentSeq,
  onChange,
  onSubagentMark,
  playing,
  onPlayingChange,
  timestampFormat,
}: TimelineProps) {
  const [speed, setSpeed] = useState<Speed>(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const total = trace?.events.length ?? 0;
  const max = Math.max(0, total - 1);
  const seq = Math.min(currentSeq, max);
  const event = trace?.events[seq];

  useEffect(() => {
    onPlayingChange(false);
  }, [trace, onPlayingChange]);

  // the timer reads position via refs so ticking doesn't tear it down
  const seqRef = useRef(seq);
  const maxRef = useRef(max);
  const playingRef = useRef(playing);
  seqRef.current = seq;
  maxRef.current = max;
  playingRef.current = playing;

  useEffect(() => {
    if (!playing || total === 0) return;
    // higher speeds keep the render rate bounded by advancing several events per tick
    const interval = Math.max(85, BASE_TICK_MS / speed);
    const step = Math.max(1, Math.round((speed * interval) / BASE_TICK_MS));
    const timer = window.setInterval(() => {
      if (seqRef.current >= maxRef.current) {
        onPlayingChange(false);
        return;
      }
      onChange(Math.min(seqRef.current + step, maxRef.current));
    }, interval);
    return () => window.clearInterval(timer);
  }, [playing, speed, total, onChange, onPlayingChange]);

  const togglePlay = useCallback(() => {
    if (!playingRef.current && seqRef.current >= maxRef.current) onChange(0);
    onPlayingChange(!playingRef.current);
  }, [onChange, onPlayingChange]);

  const step = useCallback(
    (delta: number) => {
      onChange(Math.min(maxRef.current, Math.max(0, seqRef.current + delta)));
    },
    [onChange],
  );

  // transport and scrubber are inert with no trace
  const locked = total === 0;

  useEffect(() => {
    if (locked) setMenuOpen(false);
  }, [locked]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const buckets = useMemo<Bucket[]>(() => {
    if (!trace || total === 0) return [];
    const n = Math.min(BUCKETS, total);
    const out: Bucket[] = [];
    for (let b = 0; b < n; b++) {
      const from = Math.floor((b * total) / n);
      const to = Math.floor(((b + 1) * total) / n);
      const byAction = new Map<Action, number>();
      for (let i = from; i < to; i++) {
        const action = trace.events[i]!.action;
        byAction.set(action, (byAction.get(action) ?? 0) + 1);
      }
      let dominant: Action = "other";
      let best = -1;
      // edits are rare but load-bearing: let them win the bucket color on ties
      const priority: Action[] = ["edit", "verify", "read", "search", "exec", "other"];
      for (const action of priority) {
        const count = byAction.get(action) ?? 0;
        if (count > best) {
          best = count;
          dominant = action;
        }
      }
      out.push({ from, count: to - from, dominant });
    }
    return out;
  }, [trace, total]);

  const peak = useMemo(() => buckets.reduce((acc, b) => Math.max(acc, b.count), 1), [buckets]);

  const markGroups = useMemo<MarkGroup[]>(() => {
    if (!trace) return [];
    const groups = new Map<string, MarkGroup>();
    for (const mark of trace.marks) {
      // tail marks can carry seq == events.length; clamp keeps them on the strip
      const seqC = Math.min(mark.seq, max);
      const pos = max > 0 ? seqC / max : 0;
      const key = `${mark.type}:${Math.round(pos * MARK_SLOTS)}`;
      const group = groups.get(key);
      if (group) {
        group.count++;
        group.seq = Math.min(group.seq, seqC);
      } else {
        groups.set(key, {
          key,
          type: mark.type,
          seq: seqC,
          pos,
          count: 1,
          ...(mark.note !== undefined && { note: mark.note }),
        });
      }
    }
    return [...groups.values()];
  }, [trace, max]);

  return (
    <footer className="flex flex-none flex-col gap-1.5 border-border border-t bg-card px-5 py-2.5 @max-[900px]:px-3">
      <div className="flex items-center gap-3">
        {/* band one is the instrument row: full-width strip, then position dial
            and transport anchored right — scrub on the left, numbers and
            controls where the hand rests */}
        <div className="relative mr-2.5 h-[46px] min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-2.5">
            {markGroups.map((group) => (
              <MarkGlyph
                key={group.key}
                group={group}
                disabled={locked}
                onClick={() =>
                  group.type === "subagent" && onSubagentMark
                    ? onSubagentMark(group.seq)
                    : onChange(group.seq)
                }
              />
            ))}
          </div>
          <div
            className="absolute inset-x-0 top-3 bottom-3 flex items-end gap-px border-border border-b"
            aria-hidden
          >
            {buckets.map((bucket) => (
              <span
                key={bucket.from}
                className={`min-w-0 flex-1 rounded-t-[1px] opacity-85 ${ACTION_COLOR[bucket.dominant]}`}
                style={{ height: `${18 + (bucket.count / peak) * 82}%` }}
              />
            ))}
          </div>
          {total > 0 ? (
            <div
              className="pointer-events-none absolute top-2.5 bottom-0 w-[1.5px] -translate-x-1/2 bg-foreground after:absolute after:bottom-[-2px] after:left-1/2 after:size-[5px] after:-translate-x-1/2 after:rotate-45 after:bg-foreground after:content-['']"
              style={{ left: `${(seq / Math.max(max, 1)) * 100}%` }}
              aria-hidden
            />
          ) : null}
          <input
            className="absolute inset-x-0 top-2 bottom-0 m-0 w-full cursor-ew-resize opacity-0"
            type="range"
            min={0}
            max={max}
            value={seq}
            disabled={locked}
            onChange={(e) => onChange(Number(e.currentTarget.value))}
            aria-label="Playback position"
            aria-valuetext={event ? `event ${event.seq}: ${event.tool}` : "empty"}
          />
        </div>

        {/* reserve the widest count for this session ("599 / 599") so the
            ticking digits never resize the strip beside them */}
        <div className="text-right @max-[900px]:hidden">
          <span
            className="block text-foreground text-sm tabular-nums tracking-wide"
            style={{ minWidth: `${String(Math.max(total, 1)).length * 2 + 3}ch` }}
          >
            {total > 0 ? `${seq + 1} / ${total}` : "0 / 0"}
          </span>
          <span className="block text-xs text-muted-foreground/70 tabular-nums">
            {event?.ts ? sceneClock(event.ts, timestampFormat) : "—"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <IconButton onClick={() => step(-1)} disabled={locked} label="Step back one event">
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
          <IconButton onClick={() => step(1)} disabled={locked} label="Step forward one event">
            <StepForward />
          </IconButton>
          <div className="relative" ref={menuRef}>
            {/* the trigger doubles as status: the engaged speed when it isn't 1× */}
            <IconButton
              onClick={() => setMenuOpen((v) => !v)}
              disabled={locked}
              label="More playback controls"
              expanded={menuOpen}
            >
              {speed !== 1 ? (
                <span className="font-medium text-xs tabular-nums">{speed}×</span>
              ) : (
                <Ellipsis />
              )}
            </IconButton>
            {menuOpen ? (
              <div className="mindwalk-glass absolute right-0 bottom-full z-20 mb-2 min-w-[168px] rounded-[var(--control-radius)] border border-border p-2 shadow-xl">
                <div className="flex items-center justify-between gap-2 px-1 pb-2">
                  <span className="text-xs text-muted-foreground/70 uppercase tracking-[0.08em]">
                    Speed
                  </span>
                  <div className="flex gap-1">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`rounded-sm px-1.5 py-0.5 text-xs tabular-nums ${
                          s === speed
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        onClick={() => setSpeed(s)}
                        aria-pressed={s === speed}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    onChange(0);
                    setMenuOpen(false);
                  }}
                >
                  <RotateCcw className="size-3.5" />
                  <span>Restart</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* band two is the caption line: what the playhead is on, then the key */}
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-sm">
          {event ? (
            <>
              <span className={`size-2 shrink-0 rounded-full ${ACTION_COLOR[event.action]}`} />
              <span className="flex-none font-semibold text-foreground">{event.tool}</span>
              {event.isError ? (
                <span className="flex-none text-xs text-destructive uppercase tracking-[0.08em]">
                  error
                </span>
              ) : null}
              <span className="truncate text-muted-foreground" title={event.summary}>
                {event.summary}
              </span>
            </>
          ) : (
            <span className="truncate text-muted-foreground">
              {trace
                ? "No recorded activity for this agent."
                : "Select a session to start the walk."}
            </span>
          )}
        </div>
        {/* the key is reference material; below this the caption line belongs
            to the summary alone (mindwalk's own 1180px rule) */}
        <div
          className="flex flex-none items-center gap-5 text-xs text-muted-foreground/70 uppercase tracking-[0.07em] @max-[1180px]:hidden"
          aria-hidden
        >
          <span className="inline-flex items-center gap-3">
            {STRIP_ACTIONS.map((action) => (
              <span key={action} className="inline-flex items-center gap-1.5">
                <span className={`size-2 rounded-full ${ACTION_COLOR[action]}`} />
                {action}
              </span>
            ))}
          </span>
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-[7px] rotate-45 border border-[var(--mw-mark-compaction)]" />
              compaction
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-[7px] rounded-full border border-[var(--mw-mark-subagent)]" />
              subagent
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-[7px] border-[1.5px] border-muted-foreground/70 border-b-0 border-l-0 [transform:rotate(45deg)]" />
              user turn
            </span>
          </span>
        </div>
      </div>
    </footer>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  label,
  expanded,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
  expanded?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      {...(expanded !== undefined && { "aria-haspopup": true, "aria-expanded": expanded })}
    >
      {children}
    </Button>
  );
}

/**
 * Compaction is a diamond, subagent a circle, user turn a quiet prompt
 * chevron — "an instruction was typed here", never a peer of the other two.
 * The chevron's box is an invisible 11px click target; the glyph is the
 * `::after`.
 */
function MarkGlyph({
  group,
  disabled,
  onClick,
}: {
  group: MarkGroup;
  disabled: boolean;
  onClick: () => void;
}) {
  const title = `${group.note || MARK_LABEL[group.type]}${group.count > 1 ? ` ×${group.count}` : ""}`;
  const label = `Jump to ${group.note || MARK_LABEL[group.type]} at event ${group.seq + 1}${
    group.count > 1 ? `, ${group.count} marks` : ""
  }`;
  const shared =
    "pointer-events-auto absolute cursor-pointer bg-transparent transition-transform disabled:pointer-events-none disabled:cursor-default disabled:opacity-45";

  if (group.type === "user-message") {
    return (
      <button
        type="button"
        className={`${shared} top-0 h-2.5 w-[11px] -translate-x-1/2 hover:scale-150 after:absolute after:top-[2.5px] after:left-[3px] after:size-1 after:rotate-45 after:border-[1.5px] after:border-muted-foreground/70 after:border-b-0 after:border-l-0 after:content-[''] hover:after:border-foreground`}
        style={{ left: `${group.pos * 100}%` }}
        disabled={disabled}
        title={title}
        aria-label={label}
        onClick={onClick}
      />
    );
  }

  const border =
    group.type === "subagent"
      ? "rounded-full border-[var(--mw-mark-subagent)]"
      : "border-[var(--mw-mark-compaction)]";
  return (
    <button
      type="button"
      className={`${shared} top-px size-[7px] border ${border} [transform:translateX(-50%)_rotate(45deg)] hover:[transform:translateX(-50%)_rotate(45deg)_scale(1.5)]`}
      style={{ left: `${group.pos * 100}%` }}
      disabled={disabled}
      title={title}
      aria-label={label}
      onClick={onClick}
    />
  );
}
