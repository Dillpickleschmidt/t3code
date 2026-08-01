/**
 * TraceProjection - folding a T3 thread's activities into a mindwalk trace.
 *
 * One thread is one trace. T3's activity stream is already continuous across
 * resumes and compactions, so nothing needs stitching — this walks the stream
 * in order and folds each completed tool call into one event.
 *
 * Pure and synchronous by design: it takes rows and returns a trace, so the
 * whole projection is testable without a database, a filesystem, or a running
 * provider. The one impure edge is `repoPathExists`, injected by the caller.
 *
 * ## What becomes an event, and what does not
 *
 * An event means *the agent used a tool*, which is what makes `errorRate` and
 * the histogram mean anything. So `tool.completed` folds into an event and
 * `tool.denied` into an error event that touched nothing; unfinished calls
 * (interrupted turns) have no result and are dropped; and all of T3's own
 * bookkeeping — approvals, runtime errors, checkpoints, plan updates — stays
 * off the timeline. Compactions and subagent launches are marks, not events,
 * mirroring mindwalk.
 *
 * @module TraceProjection
 */
import type { Trace, TraceEvent, TraceMark } from "@t3tools/contracts";

import {
  adaptDenial,
  adapterFor,
  type ProviderTraceAdapter,
  type ToolActivityPayload,
} from "./ProviderTraceAdapter.ts";
import { buildEvent, truncateRunes, type RepoPathExists } from "./TraceEvent.ts";
import { computeStats } from "./TraceStats.ts";

/** The activity kinds the projection reads. Everything else is bookkeeping. */
export const TRACE_ACTIVITY_KINDS = [
  "tool.completed",
  "tool.denied",
  "context-compaction",
] as const;

/** One row from `projection_thread_activities`, narrowed to what we read. */
export interface TraceActivityRow {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/** One row from `projection_thread_messages`, narrowed to what we read. */
export interface TraceMessageRow {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * Which slice of the thread to project. `main` drops any item attributed to a
 * subagent; `agent:<launchCallId>` keeps only that launch's subtree.
 *
 * Both are no-ops until the attribution edge ships, because no item carries
 * `parentToolCallId` yet — which makes `main` everything and `agent` empty.
 * Both are correct today and neither needs restructuring later.
 */
export type TraceLens =
  | { readonly kind: "main" }
  | { readonly kind: "agent"; readonly launchCallId: string };

export function parseLens(raw: string | undefined): TraceLens {
  if (raw === undefined || raw === "" || raw === "main") return { kind: "main" };
  const launchCallId = raw.startsWith("agent:") ? raw.slice("agent:".length) : "";
  return launchCallId === "" ? { kind: "main" } : { kind: "agent", launchCallId };
}

export interface TraceProjectionInput {
  readonly threadId: string;
  readonly providerName: string | null;
  readonly root: string;
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  readonly activities: ReadonlyArray<TraceActivityRow>;
  readonly messages: ReadonlyArray<TraceMessageRow>;
  readonly lens: TraceLens;
  readonly repoPathExists: RepoPathExists;
}

/**
 * The rune budget for a user-message mark's note. The note exists so the
 * timeline can show what was asked, not to mirror the transcript.
 */
const USER_MESSAGE_NOTE_LIMIT = 2000;

export function buildTrace(input: TraceProjectionInput): Trace {
  const adapter = adapterFor(input.providerName);
  const events: Array<TraceEvent> = [];
  const marks: Array<TraceMark> = [];

  const userMessages = [...input.messages]
    .filter((message) => message.role === "user")
    .sort((left, right) => compareIso(left.createdAt, right.createdAt));
  let nextMessage = 0;

  let startedAt: string | undefined;
  let endedAt: string | undefined;

  /**
   * User messages and activities live in different tables with no shared
   * ordering column — user messages are always stored `turnId: null`, and the
   * activity `sequence` is the provider's, not T3's — so `createdAt` is the
   * only key they share. It is safe here because both are stamped by the same
   * server process from the same clock. A message at the same instant as an
   * activity sorts before it: the message is what caused the activity.
   */
  const drainMessagesUpTo = (createdAt: string | null) => {
    while (nextMessage < userMessages.length) {
      const message = userMessages[nextMessage]!;
      if (createdAt !== null && compareIso(message.createdAt, createdAt) > 0) break;
      nextMessage += 1;
      const note = truncateRunes(message.text.trim(), USER_MESSAGE_NOTE_LIMIT, "…");
      marks.push({
        seq: events.length,
        type: "user-message",
        ...(note === "" ? {} : { note }),
      });
    }
  };

  /**
   * The activity query orders `sequence IS NULL` rows first, so iteration
   * order is not monotonic in `createdAt` — an unsequenced row can carry a
   * later timestamp than sequenced rows that follow it. Draining messages
   * against a clock that can go backwards would attach their marks to the
   * wrong `seq`, so drain against the high-water mark instead of the raw
   * value.
   */
  let drainedThrough: string | null = null;

  for (const activity of input.activities) {
    if (drainedThrough === null || compareIso(activity.createdAt, drainedThrough) > 0) {
      drainedThrough = activity.createdAt;
    }
    drainMessagesUpTo(drainedThrough);

    if (activity.kind === "context-compaction") {
      marks.push({ seq: events.length, type: "compaction" });
      continue;
    }

    const payload = asPayload(activity.payload);
    if (!includedByLens(payload, input.lens, adapter)) continue;

    // Bounds describe the trace being returned, so they follow the lens: an
    // `agent:<id>` lens must span its own subtree, not the whole thread, or
    // every duration derived from it is wrong.
    if (startedAt === undefined) startedAt = activity.createdAt;
    endedAt = activity.createdAt;

    if (activity.kind === "tool.denied") {
      const denial = adaptDenial(activity.payload);
      if (denial === null) continue;
      events.push(
        buildEvent(
          input.root,
          events.length,
          { ...denial.call, timestamp: activity.createdAt },
          denial.result,
          input.repoPathExists,
        ),
      );
      continue;
    }

    // A subagent launch is both a mark and an event, exactly as mindwalk does
    // for Claude's `Task`.
    if (payload.itemType === "collab_agent_tool_call") {
      const note = payload.detail ?? "";
      marks.push({
        seq: events.length,
        type: "subagent",
        ...(note === "" ? {} : { note }),
      });
    }

    const adapted = adapter.adapt(payload);
    if (adapted === null) continue;
    events.push(
      buildEvent(
        input.root,
        events.length,
        { ...adapted.call, timestamp: activity.createdAt },
        adapted.result,
        input.repoPathExists,
      ),
    );
  }
  drainMessagesUpTo(null);

  return {
    version: 1,
    session: {
      id: input.threadId,
      harness: adapter.harness,
      ...(input.model !== undefined && input.model !== "" ? { model: input.model } : {}),
      ...(input.title !== undefined && input.title !== "" ? { title: input.title } : {}),
      ...(input.root !== "" ? { cwd: input.root } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      eventCount: events.length,
    },
    events,
    marks,
    // filesInRepo is zero until the citymap is built; the caller recomputes.
    stats: computeStats({ events, marks }, 0, adapter.errorSignal),
  };
}

/**
 * The lens gate. `parentToolCallId` is the attribution edge from #20 — an
 * optional top-level field on the item payload. Nothing writes it yet, so this
 * reads `undefined` on every row today and `main` keeps everything.
 */
function includedByLens(
  payload: ToolActivityPayload & { readonly parentToolCallId?: unknown },
  lens: TraceLens,
  adapter: ProviderTraceAdapter,
): boolean {
  const parent = typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : null;
  if (lens.kind === "main") return parent === null;
  // A launch's subtree is the launching call itself plus everything attributed
  // to it. Deeper descendants arrive once #20 makes the edge self-recursive.
  return parent === lens.launchCallId || adapter.callId(payload) === lens.launchCallId;
}

function asPayload(value: unknown): ToolActivityPayload & { readonly parentToolCallId?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ToolActivityPayload)
    : {};
}

/**
 * Compare two ISO-8601 instants. Parsed, not compared as strings: activities
 * and messages are stamped by different call sites and a differing offset or
 * fractional-second precision would sort a lexicographic comparison wrong.
 * Unparseable stamps fall back to string order rather than to `NaN`.
 */
function compareIso(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return leftMs - rightMs;
}
