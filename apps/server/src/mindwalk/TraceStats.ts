/**
 * TraceStats - the session facts the HUD reads off a finished trace.
 *
 * A verbatim port of `ComputeStats` from mindwalk's `internal/model/stats.go`
 * (MIT, © 2026 Ricko Yu).
 *
 * Run twice per request: once while building the trace, with `filesInRepo` at
 * zero, and again once the citymap is known — mindwalk's own order, because the
 * citymap needs the trace's targets before the trace can know the file count.
 *
 * @module TraceStats
 */
import type {
  Trace,
  TraceAction,
  TraceActionCounts,
  TraceEvent,
  TraceMark,
  TraceObservability,
  TraceStats,
} from "@t3tools/contracts";

import { rankTouch } from "./TraceEvent.ts";

/** How confidently the source signal supports a derived metric. */
export type ObservabilityGrade = TraceObservability["reads"];

const emptyCounts = (): Mutable<TraceActionCounts> => ({
  search: 0,
  read: 0,
  edit: 0,
  exec: 0,
  verify: 0,
  other: 0,
});

/**
 * Derive session facts from a parsed trace. `errorSignal` is the adapter's
 * grade for its own error detection — "exact" when the provider flags failures
 * structurally, "estimated" when they are inferred from output text.
 */
export function computeStats(
  trace: Pick<Trace, "events" | "marks">,
  filesInRepo: number,
  errorSignal: ObservabilityGrade | "",
): TraceStats {
  const state = new Map<string, string>();
  const lastReadVersion = new Map<string, number>();
  const editVersion = new Map<string, number>();
  let readEvents = 0;
  let weakReads = 0;
  let repeatedReads = 0;
  let errors = 0;
  let firstEdit = -1;

  const actions = emptyCounts();
  const errorActions = emptyCounts();
  let resultBytes = 0;
  let editsAfterLastVerify = 0;

  for (const event of trace.events as ReadonlyArray<TraceEvent>) {
    countAction(actions, event.action);
    if (event.isError) {
      errors += 1;
      countAction(errorActions, event.action);
    }
    resultBytes += event.resultBytes;
    if (event.action === "verify") editsAfterLastVerify = 0;
    else if (event.action === "edit") editsAfterLastVerify += 1;

    for (const target of event.targets) {
      if (target.path === "") continue;
      if (rankTouch(target.touch) > rankTouch(state.get(target.path))) {
        state.set(target.path, target.touch);
      }
      if (target.touch === "edit") {
        editVersion.set(target.path, (editVersion.get(target.path) ?? 0) + 1);
      }
      if (target.touch === "read") {
        readEvents += 1;
        if (target.weak === true) weakReads += 1;
        const version = lastReadVersion.get(target.path);
        if (version !== undefined && version === (editVersion.get(target.path) ?? 0)) {
          repeatedReads += 1;
        }
        lastReadVersion.set(target.path, editVersion.get(target.path) ?? 0);
      }
      if (target.touch === "edit" && firstEdit === -1) firstEdit = event.seq;
    }
  }

  let fovea = 0;
  let parafovea = 0;
  let edited = 0;
  for (const touch of state.values()) {
    if (touch === "edit") {
      edited += 1;
      fovea += 1;
    } else if (touch === "read") {
      fovea += 1;
    } else if (touch === "hit") {
      parafovea += 1;
    }
  }

  let maxEditsPerFile = 0;
  let churnFiles = 0;
  for (const count of editVersion.values()) {
    if (count > maxEditsPerFile) maxEditsPerFile = count;
    if (count >= 3) churnFiles += 1;
  }

  let userTurns = 0;
  let compactions = 0;
  let subagents = 0;
  for (const mark of trace.marks as ReadonlyArray<TraceMark>) {
    if (mark.type === "user-message") userTurns += 1;
    else if (mark.type === "compaction") compactions += 1;
    else if (mark.type === "subagent") subagents += 1;
  }

  // Weak read targets are inferred from command text, so any of them in the mix
  // downgrades the re-read rate; no reads at all leaves it undefined.
  const reads: ObservabilityGrade =
    readEvents === 0 ? "unavailable" : weakReads === 0 ? "exact" : "estimated";

  return {
    filesInRepo,
    fovea,
    parafovea,
    edited,
    eventsBeforeFirstEdit: firstEdit >= 0 ? firstEdit : trace.events.length,
    regressionRate: readEvents > 0 ? repeatedReads / readEvents : 0,
    errorRate: trace.events.length > 0 ? errors / trace.events.length : 0,
    actions,
    errors: errorActions,
    maxEditsPerFile,
    churnFiles,
    userTurns,
    compactions,
    subagents,
    resultBytes,
    editsAfterLastVerify,
    observability: { reads, errors: errorSignal === "" ? "estimated" : errorSignal },
  };
}

function countAction(counts: Mutable<TraceActionCounts>, action: TraceAction): void {
  switch (action) {
    case "search":
      counts.search += 1;
      break;
    case "read":
      counts.read += 1;
      break;
    case "edit":
      counts.edit += 1;
      break;
    case "exec":
      counts.exec += 1;
      break;
    case "verify":
      counts.verify += 1;
      break;
    default:
      counts.other += 1;
      break;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
