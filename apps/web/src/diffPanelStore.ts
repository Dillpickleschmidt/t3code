import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null; filePath: string | null; revealRequestId: number }
  | { kind: "unstaged"; filePath: string | null; revealRequestId: number }
  | { kind: "turn"; turnId: TurnId; filePath: string | null; revealRequestId: number };

const NO_FOCUS = { filePath: null, revealRequestId: 0 } as const;
const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null, ...NO_FOCUS };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "unstaged", ...NO_FOCUS };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged", filePath?: string) => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          const focus = {
            filePath: filePath?.trim() || null,
            revealRequestId: (previous?.revealRequestId ?? 0) + 1,
          };
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef, ...focus }
                  : { kind: "unstaged", ...focus },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef, ...NO_FOCUS },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 2,
      migrate: (persisted, version) => {
        if (version >= 2 || persisted === null || typeof persisted !== "object") {
          return persisted;
        }
        const state = persisted as { byThreadKey?: Record<string, DiffPanelSelection> };
        for (const [key, selection] of Object.entries(state.byThreadKey ?? {})) {
          state.byThreadKey![key] = { ...NO_FOCUS, ...selection };
        }
        return persisted;
      },
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  hasWorkingTreeChanges = false,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return (
    byThreadKey[scopedThreadKey(ref)] ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION)
  );
}
