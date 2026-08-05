import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orderTurnDiffSummaries, resolveDiffScope } from "./diffScope";
import type { TurnDiffSummary } from "./types";

const turn = (
  id: string,
  checkpointTurnCount: number | null,
  completedAt: string,
): TurnDiffSummary =>
  ({
    turnId: TurnId.make(id),
    checkpointTurnCount,
    checkpointRef: `ref-${id}`,
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt,
  }) as unknown as TurnDiffSummary;

const FIRST = turn("turn-1", 1, "2026-01-01T00:00:00.000Z");
const SECOND = turn("turn-2", 2, "2026-01-02T00:00:00.000Z");
const THIRD = turn("turn-3", 3, "2026-01-03T00:00:00.000Z");

const ordered = orderTurnDiffSummaries([FIRST, THIRD, SECOND], {});
const counts = {};

describe("orderTurnDiffSummaries", () => {
  it("puts the newest turn first, which is what both menus call latest", () => {
    expect(ordered.map((summary) => summary.turnId)).toEqual(["turn-3", "turn-2", "turn-1"]);
  });

  it("falls back to the inferred count, then to completion time", () => {
    const a = turn("turn-a", null, "2026-01-01T00:00:00.000Z");
    const b = turn("turn-b", null, "2026-01-05T00:00:00.000Z");
    expect(
      orderTurnDiffSummaries([a, b], { [a.turnId]: 1, [b.turnId]: 2 }).map((s) => s.turnId),
    ).toEqual(["turn-b", "turn-a"]);
    // same ordinal, so the tiebreak is the clock
    expect(orderTurnDiffSummaries([a, b], {}).map((s) => s.turnId)).toEqual(["turn-b", "turn-a"]);
  });
});

describe("resolveDiffScope", () => {
  it("names the two repository scopes the way the 2D panel's menu does", () => {
    expect(
      resolveDiffScope({ kind: "unstaged", filePath: null, revealRequestId: 0 }, ordered, counts)
        .label,
    ).toBe("Working tree");
    expect(
      resolveDiffScope(
        { kind: "branch", baseRef: null, filePath: null, revealRequestId: 0 },
        ordered,
        counts,
      ).label,
    ).toBe("Branch changes");
  });

  it("calls the newest turn latest, and any other by its number", () => {
    const latest = resolveDiffScope(
      { kind: "turn", turnId: THIRD.turnId, filePath: null, revealRequestId: 1 },
      ordered,
      counts,
    );
    expect(latest.label).toBe("Latest turn");
    expect(latest.isLatestTurn).toBe(true);
    expect(latest.turn?.turnId).toBe("turn-3");

    const older = resolveDiffScope(
      { kind: "turn", turnId: FIRST.turnId, filePath: null, revealRequestId: 1 },
      ordered,
      counts,
    );
    expect(older.label).toBe("Turn 1");
    expect(older.isLatestTurn).toBe(false);
  });

  // The label is resolved rather than stored precisely so that it follows the
  // thread: the turn a user picked as "Latest turn" is no longer the latest
  // once the next turn checkpoints, and both panels have to agree on that.
  it("stops calling a turn latest once a newer one arrives", () => {
    const selection = {
      kind: "turn",
      turnId: SECOND.turnId,
      filePath: null,
      revealRequestId: 1,
    } as const;
    expect(
      resolveDiffScope(selection, orderTurnDiffSummaries([FIRST, SECOND], {}), counts).label,
    ).toBe("Latest turn");
    expect(resolveDiffScope(selection, ordered, counts).label).toBe("Turn 2");
  });

  it("falls back to the newest turn when the selected one has gone", () => {
    const resolved = resolveDiffScope(
      { kind: "turn", turnId: TurnId.make("turn-gone"), filePath: null, revealRequestId: 1 },
      ordered,
      counts,
    );
    expect(resolved.turn?.turnId).toBe("turn-3");
    expect(resolved.label).toBe("Latest turn");
  });

  it("survives a thread with no checkpoints at all", () => {
    const resolved = resolveDiffScope(
      { kind: "turn", turnId: FIRST.turnId, filePath: null, revealRequestId: 1 },
      [],
      counts,
    );
    expect(resolved.turn).toBeUndefined();
    expect(resolved.label).toBe("Turn ?");
  });
});
