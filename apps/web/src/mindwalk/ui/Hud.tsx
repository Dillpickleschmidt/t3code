import { memo, useEffect, useRef, useState } from "react";

import type { ActionCounts, CityMap, MetricObservability, Trace } from "../types";
import { Hint } from "./Hint";

export interface ChurnEntry {
  path: string;
  edits: number;
}

interface HudProps {
  trace?: Trace;
  city?: CityMap;
  agentLabel?: string;
  // live counts at the playhead, passed as primitives so memo stays effective
  editedNow: number;
  readNow: number;
  seenNow: number;
  churn: ChurnEntry[];
  onSelectFile: (path: string) => void;
  onOpenAgents?: () => void;
}

const CHURN_PANEL_ROWS = 8;

// memo: the app re-renders every playback tick; the HUD only changes when the
// session, the view toggle, or the touch counts under the playhead change
export const Hud = memo(function Hud({
  trace,
  city,
  agentLabel,
  editedNow,
  readNow,
  seenNow,
  churn,
  onSelectFile,
  onOpenAgents,
}: HudProps) {
  const stats = trace?.stats;
  const readFinal = stats ? stats.fovea - stats.edited : 0;
  const unvisitedNow = stats ? Math.max(0, stats.filesInRepo - editedNow - readNow - seenNow) : 0;
  const unvisitedFinal = stats ? Math.max(0, stats.filesInRepo - stats.fovea - stats.parafovea) : 0;
  const ghostCount = city ? city.files.reduce((n, file) => n + (file.ghost ? 1 : 0), 0) : 0;
  const errorCount = stats ? countActions(stats.errors) : 0;
  const showReview = stats
    ? errorCount > 0 || stats.churnFiles > 0 || stats.actions.edit > 0
    : false;

  const [churnOpen, setChurnOpen] = useState(false);
  const churnPanelRef = useRef<HTMLDivElement | null>(null);
  const churnToggleRef = useRef<HTMLButtonElement | null>(null);

  // a new session invalidates the open list; close instead of showing stale rows
  useEffect(() => setChurnOpen(false), [trace]);

  useEffect(() => {
    if (!churnOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (churnPanelRef.current?.contains(target) || churnToggleRef.current?.contains(target))
        return;
      setChurnOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChurnOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [churnOpen]);

  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-start justify-between gap-6 p-5 @max-[900px]:px-4 @max-[900px]:py-3.5"
      aria-hidden={!city}
    >
      <div className="pointer-events-auto min-w-0">
        <div className="flex items-baseline gap-2.5">
          <div className="truncate font-semibold text-foreground text-xl tracking-tight @max-[900px]:text-lg">
            {city ? basename(city.repo.root) : ""}
          </div>
          {/* The Lens entry point renders only once there is somewhere for it to
              go — see the agent-graph work on #21. Upstream gates it the same way. */}
          {trace && agentLabel && onOpenAgents ? (
            <button
              type="button"
              onClick={onOpenAgents}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[--control-radius] border border-border bg-card/70 px-2 py-0.5 text-muted-foreground text-xs hover:text-foreground"
              aria-label={`Open Agent lenses, current ${agentLabel}`}
            >
              <span className="text-muted-foreground/70 uppercase tracking-[0.08em]">Lens</span>
              {agentLabel}
            </button>
          ) : null}
        </div>
        {city ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.7rem] text-muted-foreground">
            <span>{city.repo.commit || "worktree"}</span>
            {city.repo.dirty ? <span className="text-warning">● dirty</span> : null}
            {trace?.session.model ? <span>{trace.session.model}</span> : null}
            {stats ? (
              <Hint text="Files in the repository map — the denominator of the coverage spectrum below">
                <span className="cursor-help">{stats.filesInRepo} files</span>
              </Hint>
            ) : null}
          </div>
        ) : null}
        {stats ? (
          <>
            {/* the spectrum doubles as scene legend and live tally: each entry is
                a touch state, counted at the playhead → across the whole walk */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <SpectrumStat
                kind="edit"
                label="edited"
                now={editedNow}
                final={stats.edited}
                hint="Files the agent changed"
              />
              <SpectrumStat
                kind="read"
                label="read"
                now={readNow}
                final={readFinal}
                hint="Files the agent opened and read, but never changed"
              />
              <SpectrumStat
                kind="hit"
                label="seen"
                now={seenNow}
                final={stats.parafovea}
                hint="Files that only appeared in search results, never opened"
              />
              <SpectrumStat
                kind="unvisited"
                label="unvisited"
                now={unvisitedNow}
                final={unvisitedFinal}
                hint="Files in the map the agent never touched"
              />
              {ghostCount > 0 ? (
                <SpectrumStat
                  kind="ghost"
                  label="ghost"
                  now={ghostCount}
                  final={ghostCount}
                  hint="Files the session touched that are gone from the repository — drawn hollow in the scene"
                />
              ) : null}
            </div>
            {/* session scale: quiet background numbers, final totals only —
                unlike the playhead-live spectrum above */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground/80 @max-[640px]:hidden">
              <Hint text={`Tool calls — ${mixHint(stats.actions)}`}>
                <span className="cursor-help">{countActions(stats.actions)} calls</span>
              </Hint>
              <Hint text="User messages — each one starts a turn of agent work">
                <span className="cursor-help">{stats.userTurns} turns</span>
              </Hint>
              {stats.subagents > 0 ? (
                // A count, not a control: upstream makes this a button because it
                // opens the Agent lenses, and until #20/#21 land there is nowhere
                // to go. A permanently disabled button would be worse than prose.
                <Hint text="Subagent launches (Task/Agent)">
                  <span className="cursor-help">
                    {stats.subagents} subagent{stats.subagents === 1 ? "" : "s"}
                  </span>
                </Hint>
              ) : null}
              {stats.compactions > 0 ? (
                <Hint text="Context compactions — the conversation was summarized to free memory">
                  <span className="cursor-help">
                    {stats.compactions} compaction{stats.compactions === 1 ? "" : "s"}
                  </span>
                </Hint>
              ) : null}
              <Hint text="Tool output the agent consumed over the session">
                <span className="cursor-help">{fmtBytes(stats.resultBytes)} output</span>
              </Hint>
              <Hint text={rereadHint(stats.observability.reads)}>
                <span className="cursor-help">
                  {stats.observability.reads === "unavailable"
                    ? "re-reads n/a"
                    : `re-reads ${approx(stats.observability.reads)}${pct(stats.regressionRate)}`}
                </span>
              </Hint>
            </div>
            {/* review: only signals worth a second look — absent when clean */}
            {showReview ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem]">
                <span className="text-muted-foreground/70 uppercase tracking-[0.1em]">review</span>
                {errorCount > 0 ? (
                  <Hint text={`${mixHint(stats.errors)}${errorCaveat(stats.observability.errors)}`}>
                    <span className="cursor-help text-warning">
                      {approx(stats.observability.errors)}
                      {errorCount} error{errorCount === 1 ? "" : "s"}
                    </span>
                  </Hint>
                ) : null}
                {stats.churnFiles > 0 ? (
                  <Hint
                    text={`Files edited in three or more separate events — the most-edited file changed ${stats.maxEditsPerFile} times. Click to list them.`}
                  >
                    <button
                      ref={churnToggleRef}
                      type="button"
                      aria-expanded={churnOpen}
                      onClick={() => setChurnOpen((open) => !open)}
                      className={`rounded-sm text-warning underline-offset-2 hover:underline ${churnOpen ? "underline" : ""}`}
                    >
                      {stats.churnFiles} file{stats.churnFiles === 1 ? "" : "s"} edited 3+ times
                    </button>
                  </Hint>
                ) : null}
                {stats.actions.edit > 0 ? (
                  stats.actions.verify === 0 ? (
                    <Hint text="The session edited files but no build or test commands were recognized (go test, make test, npm run build, …)">
                      <span className="cursor-help text-warning">never verified</span>
                    </Hint>
                  ) : stats.editsAfterLastVerify > 0 ? (
                    <Hint
                      text={`Edit events after the session's last build or test run — ${verifyRuns(stats.actions.verify)} total; pass/fail is not tracked`}
                    >
                      <span className="cursor-help text-warning">
                        {stats.editsAfterLastVerify} edit
                        {stats.editsAfterLastVerify === 1 ? "" : "s"} after last verify
                      </span>
                    </Hint>
                  ) : (
                    <Hint
                      text={`The last edit was followed by a build or test run — ${verifyRuns(stats.actions.verify)} total; pass/fail is not tracked`}
                    >
                      <span className="cursor-help text-success">verified after final edit</span>
                    </Hint>
                  )
                ) : null}
              </div>
            ) : null}
            {churnOpen ? (
              <div
                ref={churnPanelRef}
                className="mindwalk-glass mt-2 grid max-w-sm gap-0.5 rounded-[--control-radius] border border-border p-1.5 shadow-lg"
              >
                {churn.slice(0, CHURN_PANEL_ROWS).map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex items-center gap-3 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => {
                      onSelectFile(entry.path);
                      setChurnOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                      {entry.path}
                    </span>
                    <span className="shrink-0 tabular-nums text-foreground">
                      {entry.edits} edit{entry.edits === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
                {churn.length > CHURN_PANEL_ROWS ? (
                  <p className="px-2 py-1 text-[0.7rem] text-muted-foreground/70">
                    …and {churn.length - CHURN_PANEL_ROWS} more
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
});

/** Swatch colors come from `--mw-touch-*`, which is the same value the GPU
 * draws the scene with — see `../palette.ts`. */
const SWATCH: Record<string, string> = {
  edit: "bg-[var(--mw-touch-edit)]",
  read: "bg-[var(--mw-touch-read)]",
  hit: "bg-[var(--mw-touch-hit)]",
  unvisited: "bg-[var(--mw-touch-unvisited)]",
  // hollow, matching the wireframe ghost leaves in the scene
  ghost: "border border-[var(--mw-touch-ghost-border)]",
};

function SpectrumStat({
  kind,
  label,
  now,
  final,
  hint,
}: {
  kind: "edit" | "read" | "hit" | "unvisited" | "ghost";
  label: string;
  now: number;
  final: number;
  hint: string;
}) {
  return (
    <Hint text={hint}>
      <div className="flex cursor-help items-center gap-1.5 text-xs">
        <span className={`size-2 shrink-0 rounded-full ${SWATCH[kind]}`} />
        <span className="text-muted-foreground">{label}</span>
        <strong className="font-semibold text-foreground tabular-nums">
          {now === final ? final : `${now} → ${final}`}
        </strong>
      </div>
    </Hint>
  );
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function approx(observability: MetricObservability): string {
  return observability === "estimated" ? "~" : "";
}

function verifyRuns(count: number): string {
  return `${count} verify run${count === 1 ? "" : "s"}`;
}

function rereadHint(observability: MetricObservability): string {
  switch (observability) {
    case "unavailable":
      return "No file reads observed — this session reads files through commands mindwalk could not recognize";
    case "estimated":
      return "Reads that re-read a file unchanged since its last read — inferred from shell commands, so the rate is approximate";
    default:
      return "Reads that re-read a file unchanged since its last read";
  }
}

function errorCaveat(observability: MetricObservability): string {
  return observability === "estimated"
    ? " — inferred from command output; failures inside scripted calls may be missed"
    : "";
}

const ACTION_ORDER = ["search", "read", "edit", "exec", "verify", "other"] as const;

function countActions(counts: ActionCounts): number {
  return ACTION_ORDER.reduce((sum, key) => sum + counts[key], 0);
}

function mixHint(counts: ActionCounts): string {
  const parts = ACTION_ORDER.filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${key}`);
  return parts.length ? parts.join(" · ") : "none";
}

function fmtBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} B`;
  if (kb < 1000) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}
