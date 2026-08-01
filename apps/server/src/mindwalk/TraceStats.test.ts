/**
 * `computeStats`, checked against `.repos/mindwalk/internal/model/stats_test.go`
 * — all three of its tests, ported case for case.
 */
import { assert, describe, it } from "@effect/vitest";
import type { TraceEvent, TraceMark, TraceTarget } from "@t3tools/contracts";

import { computeStats } from "./TraceStats.ts";

const target = (path: string, touch: TraceTarget["touch"], weak = false): TraceTarget => ({
  path,
  touch,
  ...(weak ? { weak } : {}),
});

const event = (
  seq: number,
  action: TraceEvent["action"],
  targets: ReadonlyArray<TraceTarget> = [],
  extra: { resultBytes?: number; isError?: boolean } = {},
): TraceEvent => ({
  seq,
  tool: "t",
  action,
  targets,
  resultBytes: extra.resultBytes ?? 0,
  isError: extra.isError ?? false,
  summary: "",
});

describe("computeStats", () => {
  it("derives the fact counters", () => {
    const events = [
      event(0, "search", [target("a.go", "hit")], { resultBytes: 10 }),
      event(1, "read", [target("a.go", "read")], { resultBytes: 20 }),
      event(2, "edit", [target("a.go", "edit")]),
      event(3, "edit", [target("a.go", "edit")], { isError: true }),
      event(4, "edit", [target("a.go", "edit")]),
      event(5, "verify"),
      event(6, "edit", [target("b.go", "edit")]),
      event(7, "exec", [], { isError: true }),
    ];
    const marks: ReadonlyArray<TraceMark> = [
      { seq: 0, type: "user-message" },
      { seq: 3, type: "user-message" },
      { seq: 4, type: "compaction" },
      { seq: 5, type: "subagent" },
    ];

    const stats = computeStats({ events, marks }, 10, "exact");

    assert.deepEqual(stats.actions, { search: 1, read: 1, edit: 4, exec: 1, verify: 1, other: 0 });
    assert.deepEqual(stats.errors, { search: 0, read: 0, edit: 1, exec: 1, verify: 0, other: 0 });
    assert.equal(stats.maxEditsPerFile, 3);
    assert.equal(stats.churnFiles, 1);
    assert.equal(stats.userTurns, 2);
    assert.equal(stats.compactions, 1);
    assert.equal(stats.subagents, 1);
    assert.equal(stats.resultBytes, 30);
    assert.equal(stats.editsAfterLastVerify, 1);
    assert.equal(stats.filesInRepo, 10);
  });

  it("counts every edit when the session never verified", () => {
    const events = [
      event(0, "edit", [target("a.go", "edit")]),
      event(1, "edit", [target("b.go", "edit")]),
    ];
    assert.equal(computeStats({ events, marks: [] }, 0, "exact").editsAfterLastVerify, 2);
  });

  it("grades read confidence honestly, and a true zero as unavailable", () => {
    const strongRead = event(0, "read", [target("a.go", "read")]);
    const weakRead = event(1, "read", [target("b.go", "read", true)]);
    const hitOnly = event(0, "search", [target("c.go", "hit")]);

    assert.equal(
      computeStats({ events: [strongRead], marks: [] }, 0, "exact").observability.reads,
      "exact",
    );
    assert.equal(
      computeStats({ events: [strongRead, weakRead], marks: [] }, 0, "exact").observability.reads,
      "estimated",
    );
    assert.equal(
      computeStats({ events: [hitOnly], marks: [] }, 0, "estimated").observability.reads,
      "unavailable",
    );
    assert.equal(
      computeStats({ events: [strongRead], marks: [] }, 0, "").observability.errors,
      "estimated",
    );
  });

  it("counts a re-read only when the file did not change in between", () => {
    const read = (seq: number) => event(seq, "read", [target("a.go", "read")]);
    const edit = (seq: number) => event(seq, "edit", [target("a.go", "edit")]);

    // read, read → the second is a regression; read, edit, read → it is not.
    assert.equal(
      computeStats({ events: [read(0), read(1)], marks: [] }, 0, "exact").regressionRate,
      0.5,
    );
    assert.equal(
      computeStats({ events: [read(0), edit(1), read(2)], marks: [] }, 0, "exact").regressionRate,
      0,
    );
  });

  it("counts fovea and parafovea by each file's strongest touch", () => {
    const events = [
      event(0, "search", [target("a.go", "hit"), target("b.go", "hit")]),
      event(1, "read", [target("a.go", "read")]),
      event(2, "edit", [target("a.go", "edit")]),
    ];
    const stats = computeStats({ events, marks: [] }, 0, "exact");
    assert.equal(stats.fovea, 1);
    assert.equal(stats.parafovea, 1);
    assert.equal(stats.edited, 1);
    assert.equal(stats.eventsBeforeFirstEdit, 2);
  });
});
