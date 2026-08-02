# mindwalk port

`scene/`, `playback/`, and `types.ts` are copied near-verbatim from mindwalk's
`web/src` (MIT, © 2026 Ricko Yu — see `../../THIRD_PARTY_NOTICES.md`), vendored
at `.repos/mindwalk` at the revision this copy was taken from.

`WatchAgentSurface.tsx`, `DiffSurface.tsx`, `palette.ts`, `scene/columns.ts`,
`scene/frameLoop.ts`, `ui/CommitScrubber.tsx`, and `surface.css` are ours,
written against T3 — the equivalent of mindwalk's `App.tsx`, `state/`, and
`api/`, which are the parts of the port deliberately not copied. The verbatim
rule below binds only the copies.

Two surfaces share the stage. **3D Watch Agent** replays one thread's trace
over its repository and is mindwalk's own idea; **3D Diff** steps a range of
commits over the same citymap and has no upstream counterpart. They differ in
one thing — how tall each file's column stands and in what colour — which is
exactly what `scene/columns.ts` is.

`ui/` is mindwalk's structure restyled onto T3: the components keep upstream's
markup shape, prop contracts, derivations, and hint copy, but their 2,452 lines
of `styles.css` are gone, replaced by Tailwind on T3's design tokens. Treat
these as ours to edit, not as copies to diff.

Verbatim on purpose — but only for one reason: the squarified-treemap math,
instanced-mesh buffer indexing, and colour handling in `scene/` render _almost_
right when mistranslated, and that class of bug costs days to bisect. Staying
close is a defence against silent breakage, **not** a merge obligation. None of
this exists in `pingdotgg/t3code`, so no amount of divergence here can conflict
with a T3 upgrade, and `git subtree pull` of mindwalk is a convenience we can
give up.

So: diverge where it is a real improvement for how this repo uses the scenes,
and stay verbatim everywhere else, because a gratuitous rewrite of working
graphics code buys nothing and risks a lot. Diff against `.repos/mindwalk/web/src`
before editing `scene/` or `playback/` — so that any divergence is a decision,
recorded below, rather than a slip. Accidental deviation is still the failure
mode; deliberate deviation is not.

Beyond the deliberate list, the standing exceptions are what this repo's
stricter tsconfig forces (non-null assertions and casts, all erased at runtime)
and the pre-commit `vp fmt` autoformat.

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

## Neutrals are resolved, not declared

Every grey in the scene comes from T3 at runtime. A WebGL canvas cannot
inherit `bg-background` and `text-muted-foreground` the way the chrome does, so
the surface reads them off a probe element inside itself and hands the result
to both scenes (`resolveScenePalette`). The values in `palette.ts` are only the
fallback for when that probe cannot run.

Mindwalk's structural greys — the plain, the branches, unvisited and ghost
files, the floor plates — were a cool blue-grey family tuned against its navy
`#12151c` sky. Against T3's neutral surfaces they read as a foreign object, so
they are now expressed as _distances_ rather than colours: a percentage from
`--background` toward `--foreground` (`STRUCTURE_MIX`). That keeps mindwalk's
ordering intact — ghost dimmer than unvisited, a lit branch brighter than one
at rest — while putting every value on whatever axis T3 currently uses. One
ratio serves both themes, since "toward the foreground" already means "more
present" in either: it darkens on paper and lightens at night.

That includes the two biggest meshes on the stage, the ground plane and the
survey grid, which mindwalk declared inline as `#14171e` and friends. They are
easy to miss and expensive to get wrong: the ground is six times the map's
extent and mostly sits inside the fog, so a dark plane under a light sky is not
a dark plane — it is a full-stage gradient wash. By day the ground is the paper
itself and the gradient collapses to nothing.

The columns' baked vertical shade is themed for the same reason. Mindwalk
multiplies each column's touch colour from `0.34` at the base to `0.82` at the
crest so glow pools at the top and falls off into the plain. Multiplying toward
zero means "toward black", which only reads as falloff on an unlit stage; on
paper it puts a dark smudge at the foot of everything. By day the columns are
flat (`[1, 1]`) and the scene's own lighting does the shading.

What stays declared is what encodes _meaning_ and has no T3 counterpart: the
touch states, the timeline's action spectrum, and the mark colours. T3 has no
token for "read but not edited".

A theme switch rebuilds the scene rather than mutating materials in place. It
happens rarely, and the alternative is a second construction path that has to
stay in step with the first forever.

## Deliberate deviations from verbatim

Behavioral, and permanent:

- **`CityScene` takes `columns`, not a mode flag.** Upstream branches inside
  the scene on which prop is present — `playback` for attention, `locHeights`
  for file size, scattered through `.repos/mindwalk/web/src/scene/CityScene.tsx`
  — with an undocumented precedence rule between them. A third mode makes
  that eight representable combinations for three valid states. Here the height
  policy is lifted out to `scene/columns.ts` as one pure function per mode, and
  the scene takes the result. Stacking then needs no second mesh, the height
  maths is testable without mounting WebGL, and the walker reads a column's
  height instead of recomputing the attention curve. This is the one place a
  `git subtree pull` of mindwalk will conflict on future height tuning, and it
  is worth it.
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
  `ui/button` for every transport, dock, and close control, `ui/tooltip` for the
  `[data-hint]` `::after` bubble, `ui/separator` for the dock divider, and
  `ui/toggle-group` for the view switch (which gains the roving tabindex and
  arrow-key navigation upstream explicitly declined). Focus rings, disabled
  treatment, icon sizing, and hit targets then track the app rather than being
  restated here. The Dock's own open/close logic stays — a pop is allowed to
  coexist with an open sheet, which is not what a popover means.
- **Type comes from T3's scale.** Mindwalk's three hand-set sizes
  (`0.65`/`0.68`/`0.9rem`) are gone; hierarchy in the dense rows is carried by
  colour, which was already doing most of the work.
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
