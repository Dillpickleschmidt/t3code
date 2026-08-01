/**
 * Trace - one thread's ordered stream of file-touch events.
 *
 * A port of mindwalk's `internal/model` trace contract (MIT, © 2026 Ricko Yu).
 * The wire shape is kept byte-identical to mindwalk's JSON so the ported scene
 * and playback code reads it unchanged.
 *
 * The trace and the citymap are mutually dependent — the citymap needs the
 * trace's target paths to raise ghost buildings, and the trace needs the
 * citymap for `fileId` and `filesInRepo` — so they are built and served
 * together as a `MindwalkSnapshot`.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { Citymap } from "./citymap.ts";

/** What an event did, as the histogram and the action legend name it. */
export const TraceAction = Schema.Literals(["search", "read", "edit", "exec", "verify", "other"]);
export type TraceAction = typeof TraceAction.Type;

/**
 * How deeply an event touched a file. The colour ramp reads these as
 * seen / read / edited, and a file keeps the strongest touch it ever received.
 */
export const TraceTouch = Schema.Literals(["hit", "read", "edit"]);
export type TraceTouch = typeof TraceTouch.Type;

/**
 * One file an event touched. `weak` marks a path guessed out of command or
 * output text rather than read from a typed field — weak targets never raise
 * ghost buildings and downgrade the read-confidence grade.
 */
export const TraceTarget = Schema.Struct({
  path: Schema.String,
  fileId: Schema.optionalKey(NonNegativeInt),
  touch: TraceTouch,
  lines: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
  weak: Schema.optionalKey(Schema.Boolean),
});
export type TraceTarget = typeof TraceTarget.Type;

/** A file the agent touched outside the repository, kept only as a tally. */
export const TraceOutsideTouch = Schema.Struct({
  scope: Schema.Literals(["home", "tmp", "other"]),
  path: Schema.String,
});
export type TraceOutsideTouch = typeof TraceOutsideTouch.Type;

/** One completed tool call. */
export const TraceEvent = Schema.Struct({
  seq: NonNegativeInt,
  ts: Schema.optionalKey(Schema.String),
  tool: Schema.String,
  action: TraceAction,
  targets: Schema.Array(TraceTarget),
  outside: Schema.optionalKey(Schema.Array(TraceOutsideTouch)),
  resultBytes: NonNegativeInt,
  isError: Schema.Boolean,
  summary: Schema.String,
});
export type TraceEvent = typeof TraceEvent.Type;

/**
 * A moment on the timeline that is not a tool call. `seq` is the event index
 * the mark sits before, so a mark can land past the last event.
 */
export const TraceMark = Schema.Struct({
  seq: NonNegativeInt,
  type: Schema.Literals(["compaction", "user-message", "subagent"]),
  note: Schema.optionalKey(Schema.String),
});
export type TraceMark = typeof TraceMark.Type;

/** Per-action tallies; as `Stats.errors`, only the events that failed. */
export const TraceActionCounts = Schema.Struct({
  search: NonNegativeInt,
  read: NonNegativeInt,
  edit: NonNegativeInt,
  exec: NonNegativeInt,
  verify: NonNegativeInt,
  other: NonNegativeInt,
});
export type TraceActionCounts = typeof TraceActionCounts.Type;

/**
 * Grades each derived metric's source signal so the UI can tell a true zero
 * from a blind spot: "exact" when the provider records the signal structurally,
 * "estimated" when it is inferred from command or output text, "unavailable"
 * when there is no usable signal at all.
 */
export const TraceObservability = Schema.Struct({
  reads: Schema.Literals(["exact", "estimated", "unavailable"]),
  errors: Schema.Literals(["exact", "estimated", "unavailable"]),
});
export type TraceObservability = typeof TraceObservability.Type;

export const TraceStats = Schema.Struct({
  filesInRepo: NonNegativeInt,
  fovea: NonNegativeInt,
  parafovea: NonNegativeInt,
  edited: NonNegativeInt,
  eventsBeforeFirstEdit: NonNegativeInt,
  regressionRate: Schema.Number,
  errorRate: Schema.Number,
  actions: TraceActionCounts,
  errors: TraceActionCounts,
  maxEditsPerFile: NonNegativeInt,
  /** files edited in three or more events */
  churnFiles: NonNegativeInt,
  userTurns: NonNegativeInt,
  compactions: NonNegativeInt,
  subagents: NonNegativeInt,
  resultBytes: NonNegativeInt,
  /** edit events after the last verify; every edit event when nothing verified */
  editsAfterLastVerify: NonNegativeInt,
  observability: TraceObservability,
});
export type TraceStats = typeof TraceStats.Type;

export const TraceSession = Schema.Struct({
  id: Schema.String,
  harness: Schema.String,
  model: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  endedAt: Schema.optionalKey(Schema.String),
  eventCount: NonNegativeInt,
});
export type TraceSession = typeof TraceSession.Type;

export const Trace = Schema.Struct({
  version: NonNegativeInt,
  session: TraceSession,
  events: Schema.Array(TraceEvent),
  marks: Schema.Array(TraceMark),
  stats: TraceStats,
});
export type Trace = typeof Trace.Type;

/**
 * Which slice of the thread the trace covers. `main` is the root agent's own
 * work, `agent:<launchCallId>` one subagent launch's subtree — mindwalk's Main
 * and per-agent lenses.
 */
export const TraceLens = Schema.String.pipe(
  Schema.brand("TraceLens"),
  Schema.annotate({ description: "main | agent:<launchCallId>" }),
);
export type TraceLens = typeof TraceLens.Type;

/**
 * What the 3D surfaces fetch: one thread's trace and the citymap its targets
 * are laid out on, built together in one request.
 */
export const MindwalkSnapshot = Schema.Struct({
  trace: Trace,
  citymap: Citymap,
});
export type MindwalkSnapshot = typeof MindwalkSnapshot.Type;
