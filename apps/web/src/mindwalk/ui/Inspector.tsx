import { AlertTriangle, X } from "lucide-react";

import { touchWord, type CityFile, type Touch, type TraceEvent } from "../types";

interface InspectorProps {
  /** absent when nothing is selected yet — renders the teaching empty state */
  file?: CityFile;
  touch?: Touch;
  history: TraceEvent[];
  onClose: () => void;
  onJumpTo: (seq: number) => void;
}

/** Touch words carry the scene's own colors, so the panel agrees with the
 * building it is describing. */
const TOUCH_COLOR: Record<Touch, string> = {
  edit: "text-[var(--mw-touch-edit)]",
  read: "text-[var(--mw-touch-read)]",
  hit: "text-[var(--mw-touch-hit)]",
};

const ACTION_COLOR: Record<string, string> = {
  search: "bg-[var(--mw-act-search)]",
  read: "bg-[var(--mw-act-read)]",
  edit: "bg-[var(--mw-act-edit)]",
  verify: "bg-[var(--mw-act-verify)]",
  exec: "bg-[var(--mw-act-exec)]",
  other: "bg-[var(--mw-act-other)]",
};

// dock panel content: the selected file's identity, touch state, and visit
// history. The Dock owns positioning; this owns only its own markup.
export function Inspector({ file, touch, history, onClose, onJumpTo }: InspectorProps) {
  if (!file) {
    return (
      <div className="flex h-full flex-col p-3" aria-label="File inspector">
        <Head onClose={onClose}>
          <div className="font-semibold text-foreground text-sm">Inspect</div>
        </Head>
        <p className="mt-3 text-muted-foreground text-xs leading-relaxed">
          Click a building in the scene to inspect a file — its touch state, size, and every visit
          the agent paid it.
        </p>
      </div>
    );
  }
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;

  return (
    <div className="flex h-full flex-col p-3" aria-label={`File ${file.path}`}>
      <Head onClose={onClose}>
        <div className="min-w-0">
          <div className="truncate font-mono text-foreground text-sm">
            <span className="text-muted-foreground/70">{dir}</span>
            {name}
          </div>
          {file.ghost ? (
            <span className="mt-1 inline-block rounded-sm border border-[var(--mw-touch-ghost-border)] px-1.5 py-px text-[0.65rem] text-muted-foreground">
              ghost — not in this tree
            </span>
          ) : null}
        </div>
      </Head>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Fact label="Touch">
          <span className={touch ? TOUCH_COLOR[touch] : undefined}>{touchWord(touch)}</span>
        </Fact>
        <Fact label="Lang">{file.lang || "text"}</Fact>
        <Fact label="Lines">{file.lines.toLocaleString()}</Fact>
        <Fact label="Bytes">{file.bytes.toLocaleString()}</Fact>
      </dl>

      <section className="mt-4 flex min-h-0 flex-1 flex-col">
        <p className="text-[0.65rem] text-muted-foreground/70 uppercase tracking-[0.1em]">
          Visits · {history.length}
        </p>
        <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto">
          {history
            .slice(-14)
            .toReversed()
            .map((event) => (
              <button
                key={event.seq}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent"
                onClick={() => onJumpTo(event.seq)}
                title={`Jump to step ${event.seq + 1} — ${event.summary}`}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${ACTION_COLOR[event.action] ?? ACTION_COLOR.other}`}
                />
                <strong className="shrink-0 font-semibold text-foreground tabular-nums">
                  #{event.seq + 1}
                </strong>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{event.tool}</span>
                <span className="shrink-0 text-[0.65rem] text-muted-foreground/70 tabular-nums">
                  {event.ts ? clock(event.ts) : ""}
                </span>
                {event.isError ? (
                  <AlertTriangle className="shrink-0 text-destructive" size={13} />
                ) : (
                  <span className="size-[13px] shrink-0" />
                )}
              </button>
            ))}
          {history.length === 0 ? (
            <p className="px-1.5 text-muted-foreground text-xs leading-relaxed">
              Not visited yet at this point of the walk. Scrub the timeline forward.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Head({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2">
      {children}
      <button
        type="button"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-[--control-radius] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onClose}
        title="Close"
        aria-label="Close inspector"
      >
        <X size={15} />
      </button>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.65rem] text-muted-foreground/70 uppercase tracking-[0.08em]">
        {label}
      </dt>
      <dd className="mt-0.5 text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
