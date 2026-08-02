# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: each app and package under `apps/` and `packages/` owns its own vocabulary, and a root `CONTEXT-MAP.md` points at them.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`<context>/CONTEXT.md`** — the vocabulary for a single app or package, e.g. `apps/server/CONTEXT.md`.
- **`docs/adr/`** at the root — system-wide architectural decisions.
- **`<context>/docs/adr/`** — decisions scoped to one app or package, e.g. `packages/contracts/docs/adr/`.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Relationship to the existing docs

These files complement, and do not replace, what's already here:

- **`AGENTS.md` § "A small glossary"** — project-wide terms every agent must use (_environment_, _project_, _thread_, _turn_, _provider_, _client_). This is the top-level authority; a `CONTEXT.md` must not contradict it.
- **`docs/internals/glossary.md`** — the existing prose glossary with file links.
- **`docs/`** splits by audience (`user/`, `internals/`, `operations/`, `architecture/`) per `AGENTS.md` § "Hit every surface". Domain docs are a separate axis: `CONTEXT.md` is scoped by _context_, not by audience.

## File structure

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
├── apps/
│   ├── server/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                  ← context-specific decisions
│   ├── web/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/
│   ├── desktop/
│   ├── mobile/
│   └── marketing/
└── packages/
    ├── contracts/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── shared/
    ├── client-runtime/
    ├── effect-acp/
    ├── effect-codex-app-server/
    ├── ssh/
    └── tailscale/
```

A decision that crosses the wire — anything touching `packages/contracts` — is system-wide by definition and belongs in the root `docs/adr/`, not in one client's.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
