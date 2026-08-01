# mindwalk port

`scene/`, `playback/`, and `types.ts` are copied near-verbatim from mindwalk's
`web/src` (MIT, © 2026 Ricko Yu — see `../../THIRD_PARTY_NOTICES.md`), vendored
at `.repos/mindwalk` at the revision this copy was taken from.

`WatchAgentSurface.tsx` and `surface.css` are ours, written against T3 — the
equivalent of mindwalk's `App.tsx`, `state/`, and `api/`, which are the parts of
the port deliberately not copied. The verbatim rule below binds only the copies.

Verbatim on purpose: the squarified-treemap math, instanced-mesh buffer
indexing, and colour handling in this code render _almost_ right when
mistranslated, and that class of bug costs days to bisect. Deviations are
limited to what this repo's stricter tsconfig forces (non-null assertions and
casts, all erased at runtime) plus the pre-commit `vp fmt` autoformat, and each
must preserve behavior. Diff against `.repos/mindwalk/web/src` before editing
anything here.

## Deliberate deviations from verbatim

These behavioral deviations are intentional and permanent, because AGENTS.md's
"no continuously repainting animations" rule outranks fidelity here:

- **`scene/frameLoop.ts` is ours, not mindwalk's.** Both scenes drive it
  instead of mindwalk's unconditional `requestAnimationFrame` loop, so a
  visible but idle scene issues zero draw calls. See the file's header for the
  three inputs that book a frame.
- **`controls.autoRotate` is time-bounded.** Mindwalk drifts the camera until
  the first interaction, which on a view you open and never touch is unbounded
  motion on a parked, visible host. The drift is kept — it is how the scene
  reads as 3D on arrival — but now ends at whichever comes first: that first
  interaction, still mindwalk's own rule, or `ATTRACT_DRIFT_MS`. Reduced-motion
  users get no drift, as upstream.
- **The firefly's sine pulse only runs while playback is running**, gated by
  the `playing` prop both scenes now take.
- **`DirLabelSet.ease`, and the height/halo lerps, report whether they moved.**
  The loop needs to know when an animation has finished; upstream never asked.
