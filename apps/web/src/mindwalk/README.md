# mindwalk port

`scene/`, `playback/`, and `types.ts` are copied near-verbatim from mindwalk's
`web/src` (MIT, © 2026 Ricko Yu — see `../../THIRD_PARTY_NOTICES.md`), vendored
at `.repos/mindwalk` at the revision this copy was taken from.

`WatchAgentSurface.tsx`, `palette.ts`, and `surface.css` are ours, written
against T3 — the equivalent of mindwalk's `App.tsx`, `state/`, and `api/`,
which are the parts of the port deliberately not copied. The verbatim rule
below binds only the copies.

`ui/` is mindwalk's structure restyled onto T3: the components keep upstream's
markup shape, prop contracts, derivations, and hint copy, but their 2,452 lines
of `styles.css` are gone, replaced by Tailwind on T3's design tokens. Treat
these as ours to edit, not as copies to diff.

Verbatim on purpose: the squarified-treemap math, instanced-mesh buffer
indexing, and colour handling in `scene/` render _almost_ right when
mistranslated, and that class of bug costs days to bisect. Deviations are
limited to what this repo's stricter tsconfig forces (non-null assertions and
casts, all erased at runtime), the pre-commit `vp fmt` autoformat, and the
deliberate list below. Diff against `.repos/mindwalk/web/src` before editing
anything in `scene/` or `playback/`.

## Light and dark

Mindwalk is dark-only: a nocturnal observatory where _light is data_, and only
touch states and trails may glow. T3 has a real light theme, so the surface
carries a second palette rather than pinning itself dark.

Light mode inverts the metaphor with the background — a **daylight survey**,
where ink is data. Near-white ground, graphite masses, touch states as
saturated ink. Hue is preserved exactly, because hue is the meaning the HUD
legend promises; only lightness flips. The glow model flips with it:
`AdditiveBlending` emits onto darkness, `NormalBlending` absorbs onto paper.
Both preserve the two properties the scene actually depends on — soft falloff,
from the sprite's alpha, and accumulation, where overlapping marks deepen.

Every value for both palettes lives in `palette.ts`, which is also where the
chrome's legend swatches come from, so a dot in the HUD cannot disagree with
the material it describes. **Dark mode remains the fidelity reference**: it is
what a live `mindwalk serve` renders, and what screenshot parity is checked
against.

A theme switch rebuilds the scene rather than mutating materials in place. It
happens rarely, and the alternative is a second construction path that has to
stay in step with the first forever.

## Deliberate deviations from verbatim

Behavioral, and permanent:

- **`scene/frameLoop.ts` is ours, not mindwalk's.** Both scenes drive it
  instead of mindwalk's unconditional `requestAnimationFrame` loop, so a
  visible but idle scene issues zero draw calls. AGENTS.md's "no continuously
  repainting animations" rule outranks fidelity here. See the file's header for
  the three inputs that book a frame.
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
- **The Timeline's transport keyboard shortcuts are gone.** Upstream installs a
  `window`-level listener for Space, arrows, Home/End, and `S`/`E`/`X`/`M`,
  which is fine when it owns the window and wrong in a panel that can sit
  inactive behind chat or a terminal. Any bindings this surface grows belong to
  T3's own keybinding system, not a second one. The UI labels that advertised
  them went with them.
- **Video export is stripped.** `playback/recorder.ts`, `onExport`, and the
  `exporting`/`locked` plumbing that existed only to serve it are all deleted.

Visual, and the point of the restyle:

- **Both themes**, as above.
- **T3's type and tokens.** Mindwalk's Fraunces display face and Schibsted
  Grotesk body are replaced by T3's `--font-sans` (DM Sans) and `--font-mono`.
  This includes `textures.ts:labelTexture()`, whose in-scene directory labels
  asked for a face this app does not ship and were silently falling back.
- **T3 primitives replace hand-rolled ones** where the swap is presentational:
  `ui/tooltip` for the `[data-hint]` `::after` bubble, `ui/separator` for the
  dock divider, `ui/toggle-group` for the view switch (which gains the roving
  tabindex and arrow-key navigation upstream explicitly declined). The Dock's
  own open/close logic stays — a pop is allowed to coexist with an open sheet,
  which is not what a popover means.
- **Responsive rules are keyed to the container, not the viewport.** Mindwalk's
  own breakpoints are preserved (`1180px` drops the timeline legend, `900px`
  turns the dock into a bottom sheet and hides the position dial), but as
  `@container` queries, because this surface is a resizable panel whose width
  is independent of the window. A viewport query would give a maximized panel
  and a narrow one the same layout.

## Not ported

`ui/SessionRail.tsx`, `ui/ReportPanel.tsx`, `ui/AgentsPanel.tsx`,
`ui/LogoMark.tsx`, and `ui/shortcuts.ts`. The rail and the judge are out of
scope for this effort; the agents panel waits on the agent-graph endpoint.
