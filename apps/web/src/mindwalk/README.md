# mindwalk port

`scene/`, `playback/`, and `types.ts` are copied near-verbatim from mindwalk's
`web/src` (MIT, © 2026 Ricko Yu — see `../../THIRD_PARTY_NOTICES.md`), vendored
at `.repos/mindwalk` at the revision this copy was taken from.

Verbatim on purpose: the squarified-treemap math, instanced-mesh buffer
indexing, and colour handling in this code render _almost_ right when
mistranslated, and that class of bug costs days to bisect. Deviations are
limited to what this repo's stricter tsconfig forces (non-null assertions and
casts, all erased at runtime) plus the pre-commit `vp fmt` autoformat, and each
must preserve behavior. Diff against `.repos/mindwalk/web/src` before editing
anything here.
