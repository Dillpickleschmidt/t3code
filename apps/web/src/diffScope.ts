/**
 * The four diff scopes, resolved once for both panels that draw them.
 *
 * The 2D Diff panel and 3D Diff read the *same* selection out of
 * `diffPanelStore`, so they have to turn it into the same scope and call it by
 * the same name. A range labelled "Latest turn" in one panel and "Turn 7" in
 * the other is the same class of drift as the two disagreeing about
 * whitespace: one store, two readings. So the reading lives here, and neither
 * panel derives it for itself.
 *
 * The store deliberately holds three selection kinds for four menu entries —
 * "Latest turn" and "Turn N" are one `turn` selection, distinguished by
 * whether it happens to name the newest checkpoint. That is a property of the
 * thread rather than of the selection, so it is resolved rather than stored:
 * the entry a user picked as "Latest turn" stops being the latest the moment
 * the next turn checkpoints, and the label should follow.
 *
 * @module diffScope
 */
import type { TurnId } from "@t3tools/contracts";

import type { DiffPanelSelection } from "./diffPanelStore";
import type { TurnDiffSummary } from "./types";

/**
 * Newest turn first, which is the order both scope menus list them in and the
 * order that makes entry zero "latest".
 */
export function orderTurnDiffSummaries(
  summaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>,
): ReadonlyArray<TurnDiffSummary> {
  return [...summaries].toSorted((left, right) => {
    const leftTurnCount =
      left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
    const rightTurnCount =
      right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
    if (leftTurnCount !== rightTurnCount) {
      return rightTurnCount - leftTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });
}

export interface ResolvedDiffScope {
  /** Which of the store's three selection kinds is live. */
  readonly kind: DiffPanelSelection["kind"];
  /**
   * The checkpoint a turn scope resolved to, or undefined outside a turn
   * scope. A stored turn that the thread no longer has falls back to the
   * newest one rather than to nothing — the same reconciliation
   * `reconcileTurnSelection` performs against the store, applied on read so a
   * panel is never left pointing at a turn that has gone.
   */
  readonly turn: TurnDiffSummary | undefined;
  /** The turn's ordinal, as both menus number them. */
  readonly turnCount: number | undefined;
  readonly isLatestTurn: boolean;
  /** What the scope menu's trigger reads. One of the four entry names. */
  readonly label: string;
}

export function resolveDiffScope(
  selection: DiffPanelSelection,
  orderedTurnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>,
): ResolvedDiffScope {
  if (selection.kind !== "turn") {
    return {
      kind: selection.kind,
      turn: undefined,
      turnCount: undefined,
      isLatestTurn: false,
      label: selection.kind === "unstaged" ? "Working tree" : "Branch changes",
    };
  }
  const turn =
    orderedTurnDiffSummaries.find((summary) => summary.turnId === selection.turnId) ??
    orderedTurnDiffSummaries[0];
  const turnCount =
    turn && (turn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[turn.turnId]);
  const isLatestTurn = turn !== undefined && turn.turnId === orderedTurnDiffSummaries[0]?.turnId;
  return {
    kind: "turn",
    turn,
    turnCount: turnCount === null ? undefined : turnCount,
    isLatestTurn,
    label: isLatestTurn ? "Latest turn" : `Turn ${turnCount ?? "?"}`,
  };
}
