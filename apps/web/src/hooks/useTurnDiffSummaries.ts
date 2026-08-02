import { useMemo } from "react";
import { orderTurnDiffSummaries } from "../diffScope";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread, TurnDiffSummary } from "../types";

export function useTurnDiffSummaries(activeThread: Thread | null | undefined) {
  const turnDiffSummaries = useMemo<ReadonlyArray<TurnDiffSummary>>(() => {
    if (!activeThread) {
      return [];
    }
    return activeThread.checkpoints;
  }, [activeThread]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  // Ordered here rather than at each call site: both Diff panels list turns
  // newest-first and both call entry zero "latest", so a second copy of the
  // sort is a second chance for them to disagree about which turn that is.
  const orderedTurnDiffSummaries = useMemo(
    () => orderTurnDiffSummaries(turnDiffSummaries, inferredCheckpointTurnCountByTurnId),
    [turnDiffSummaries, inferredCheckpointTurnCountByTurnId],
  );

  return { turnDiffSummaries, orderedTurnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
