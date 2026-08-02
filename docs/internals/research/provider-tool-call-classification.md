# Classifying read and search tool calls per provider adapter

Research for [#4](https://github.com/Dillpickleschmidt/t3code/issues/4) (part of #1). Groundwork for
porting mindwalk's 3D visualisations, whose colour ramp needs `seen` / `read` / `edited` per file.

All `file:line` citations are repo-relative and were read directly from source in this worktree
(commit `a83fa5863`). Where source alone does not settle a question, it is called out as
**UNVERIFIED** rather than guessed.

---

## 0. TL;DR — the five things that change the port's difficulty

1. **The ticket's premise is half wrong, and it is the expensive half.** `data` survives into the
   database intact, but `projectActivityPayload` **replaces `data` with a six-key whitelist before
   it reaches any client** (`apps/server/src/orchestration/ActivityPayloadProjection.ts:167-201`).
   `toolName`, `input`, `rawInput`, `locations`, and `state` are all dropped on the wire. Any
   client-side classifier is dead on arrival until that whitelist is widened. See §5.
2. **Only Claude emits `data.toolName` / `data.input` at all.** The other four use different shapes:
   Codex `data.item.*`, Cursor/Grok `data.kind` + `data.rawInput` + `data.locations`, OpenCode
   `data.tool` + `data.state`. A classifier written against Claude's shape reads `undefined` on
   every other provider. See §2.
3. **Codex cannot distinguish reads at the item level at all** — it has no read/grep/glob tool; the
   agent shells out and everything arrives as `command_execution`. But Codex _already pre-parses the
   shell command_ into `commandActions[] : { type: "read" | "listFiles" | "search", path, query }`
   (`packages/effect-codex-app-server/src/_generated/schema.gen.ts:14494-14508`), and the adapter
   throws that away. This is the single highest-leverage fix in the whole ticket: it turns "parse
   shell strings" into "read a field". See §3 and §4.
4. **ACP (`Cursor`, `Grok`) maps `kind: "search"` → `web_search`**
   (`apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:55-57`). A codebase grep is
   indistinguishable from a web fetch by `itemType`. `kind: "read"` falls through to
   `dynamic_tool_call`. Both are recoverable from `data.kind`, which happens to be one of the six
   whitelisted keys — so Cursor/Grok are the _best-off_ providers post-projection.
5. **`truncateDetail`'s 180-char cap is a non-issue.** It is `(value: string) => string`
   (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:203-205`) and is applied only
   to `detail` / `summary` / `message` strings, never to `data`. See §5.

---

## 1. Canonical taxonomy and where classification is lost

`packages/contracts/src/providerRuntime.ts:104-111`:

```ts
export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;
```

There is no `file_read` and no `file_search` member. `isToolLifecycleItemType`
(`packages/contracts/src/providerRuntime.ts:117-119`) gates which runtime events become activities
at all, so adding a new member is a contract change touching every adapter plus both clients — out
of scope here; this document assumes the taxonomy stays fixed and classification happens
_downstream_ from `data`.

`data` is typed open at every hop, which is what makes downstream recovery possible:

- `packages/contracts/src/providerRuntime.ts:404-410` — `ItemLifecyclePayload.data: Schema.optional(Schema.Unknown)`
- `packages/contracts/src/orchestration.ts:315-325` — `OrchestrationThreadActivity.payload: Schema.Unknown`

Because both are `Schema.Unknown` (identity, not a closed struct), **no Effect Schema decode
anywhere on the path can strip unknown keys from `data`.** This was the crux risk and it is clear.

---

## 2. Per-adapter table: tool name → item type → path location

### 2.1 Claude — `apps/server/src/provider/Layers/ClaudeAdapter.ts`

Claude is the only adapter that classifies on a **tool name string** and the only one that emits
`data: { toolName, input, result }`.

Emit sites (three, all with `data`):

| Event                                      | Line                                                      | `data` shape                  |
| ------------------------------------------ | --------------------------------------------------------- | ----------------------------- |
| `item.started`                             | `ClaudeAdapter.ts:2201-2204`                              | `{ toolName, input }`         |
| `item.updated` (input streaming)           | `ClaudeAdapter.ts:2208-2211`                              | `{ toolName, input }`         |
| `item.updated` + `item.completed` (result) | `ClaudeAdapter.ts:2361-2365`, used at `:2381` and `:2433` | `{ toolName, input, result }` |

`toolName` is the raw upstream block name, unmodified: `const toolName = block.name;`
(`ClaudeAdapter.ts:2146`). `input` is the raw tool input object, unmodified
(`ClaudeAdapter.ts:2148-2151`); during streaming it is the incrementally re-parsed
`input_json_delta` accumulation (`ClaudeAdapter.ts:2155-2167`).

Classification is `classifyToolItemType` (`ClaudeAdapter.ts:596-638`), an ordered `includes()`
ladder ending in `return "dynamic_tool_call";` at `:637`.

| Tool name                            | Matched branch                                 | itemType                                                         | Path in `input`                                                                       |
| ------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Read`                               | none                                           | `dynamic_tool_call` (`:637`)                                     | `input.file_path` — **UNVERIFIED**, see note                                          |
| `Grep`                               | none                                           | `dynamic_tool_call` (`:637`)                                     | `input.path` (search root) + `input.pattern` (query) — verified by fixture, see below |
| `Glob`                               | none                                           | `dynamic_tool_call` (`:637`)                                     | `input.path` (search root) + `input.pattern` — **UNVERIFIED**                         |
| `Edit` / `Write` / `MultiEdit`       | `includes("edit"｜"write")` (`:617-627`)       | `file_change`                                                    | `input.file_path` — **UNVERIFIED**                                                    |
| `NotebookEdit`                       | `includes("edit")` (`:618`)                    | `file_change`                                                    | notebook path — **UNVERIFIED**                                                        |
| `Bash` / `BashOutput` / `KillShell`  | `includes("bash")` (`:610`)                    | `command_execution`                                              | `input.command` (shell string only)                                                   |
| `Task` / anything containing `agent` | `:598-608`                                     | `collab_agent_tool_call`                                         | n/a                                                                                   |
| `WebSearch` / `WebFetch`\*           | `includes("websearch"｜"web search")` (`:631`) | `web_search` (`WebFetch` → falls through to `dynamic_tool_call`) | n/a                                                                                   |
| `mcp__*`                             | `includes("mcp")` (`:628`)                     | `mcp_tool_call`                                                  | server-specific                                                                       |
| `TodoWrite`                          | `includes("write")` (`:619`)                   | `file_change` (misclassification)                                | n/a — also drives `turn.plan.updated` at `:2221-2229`                                 |

`Grep`'s input shape is confirmed by an in-repo fixture, which is a primary source for the wire
shape as T3 actually observes it — `apps/server/src/provider/Layers/ClaudeAdapter.test.ts:1190-1197`:

```ts
assert.deepEqual(toolInputUpdated.payload.data, {
  toolName: "Grep",
  input: {
    pattern: "foo",
    path: "src",
  },
});
```

**UNVERIFIED — `Read`/`Edit`/`Write` input key name.** `node_modules` is not installed in this
worktree, so `@anthropic-ai/claude-agent-sdk`'s tool-input types could not be read. Claude Code's
documented shape is snake*case `file_path`, and the one `Read` fixture in the repo
(`ClaudeAdapter.test.ts:2180`, `input: { path: "a.ts" }`) is hand-written and does **not** prove the
real key. What \_is* verified and load-bearing:

```
$ grep -rn "file_path" apps/server/src packages/shared/src packages/contracts/src
(no matches)
```

**Nothing in T3 looks for a snake_case path key.** Both path walkers key only on
`path | filePath | relativePath | filename | newPath | oldPath`
(`apps/server/src/orchestration/ActivityPayloadProjection.ts:54-59`,
`packages/shared/src/toolActivity.ts:112`). So if Claude really does send `file_path`, then today:

- a Claude **`Grep`** contributes its _search root_ to `files` (via `input.path`), and
- a Claude **`Edit`/`Read`** contributes **nothing** — the actual touched file is invisible.

That inversion is worth confirming against a live capture before building on it. It is cheap to
settle: log one `Edit` activity's `payload.data.input` keys.

`isReadOnlyToolName` (`ClaudeAdapter.ts:640-650`) already encodes exactly the read/search predicate
this ticket wants — but it is only consumed by `classifyRequestType` (`:652-662`) for _permission
prompts_, never for item typing:

```ts
function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}
```

Note it does not separate _read_ from _search_ — both collapse to `file_read_approval`. A
mindwalk-grade classifier needs them split; reuse the predicate's vocabulary, not its return type.

### 2.2 Codex — `apps/server/src/provider/Layers/CodexAdapter.ts`

Codex does **no tool-name classification whatsoever**. It classifies on the Codex app-server
protocol's own `item.type` discriminator via a normalise-then-substring ladder
(`normalizeItemType` `:207-216`, `toCanonicalItemType` `:218-237`).

`grep -n "toolName" apps/server/src/provider/Layers/Codex*.ts` → **zero hits.**

`data` is the **entire raw notification `params`**, attached verbatim —
`CodexAdapter.ts:492`:

```ts
      ...(event.payload !== undefined ? { data: event.payload } : {}),
```

`event.payload` is set by a pure pass-through in `CodexSessionRuntime.ts:844` (`const payload =
notification.params;`) and `:898`. So the shape is
`data = { threadId, turnId, startedAtMs|completedAtMs, item: <raw ThreadItem> }`. Pinned by
`apps/server/src/provider/Layers/CodexAdapter.test.ts:597-612`.

| Codex `item.type`     | itemType (`:218-237`)             | tool-name-ish field                   | Path location                                                                                                     |
| --------------------- | --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `commandExecution`    | `command_execution` (`:224`)      | none                                  | `data.item.command` (shell string); structured paths in `data.item.commandActions[]` — **ignored by the adapter** |
| `fileChange`          | `file_change` (`:225-226`)        | none                                  | `data.item.changes[i].path` (`schema.gen.ts:14554-14558`)                                                         |
| `mcpToolCall`         | `mcp_tool_call` (`:227`)          | `data.item.server` + `data.item.tool` | server-specific, in `data.item.arguments`                                                                         |
| `dynamicToolCall`     | `dynamic_tool_call` (`:228`)      | `data.item.tool` (+ `namespace`)      | in `data.item.arguments`                                                                                          |
| `collabAgentToolCall` | `collab_agent_tool_call` (`:229`) | `data.item.tool`                      | n/a                                                                                                               |
| `webSearch`           | `web_search` (`:230`)             | none                                  | n/a (`data.item.query`)                                                                                           |
| `imageView`           | `image_view` (`:231`)             | none                                  | `data.item.path`                                                                                                  |

**There is no read, grep, glob or list tool in Codex's item union.** The only read-flavoured
protocol surface is the approval RPC `item/fileRead/requestApproval` → `file_read_approval`
(`CodexAdapter.ts:299-300`), which produces a `CanonicalRequestType`, never an item.

**The buried treasure.** Codex pre-parses every shell command into typed actions —
`packages/effect-codex-app-server/src/_generated/schema.gen.ts:14494-14508`:

```ts
export type V2ItemStartedNotification__CommandAction =
  | {
      readonly command: string;
      readonly name: string;
      readonly path: V2ItemStartedNotification__AbsolutePathBuf;
      readonly type: "read";
    }
  | { readonly command: string; readonly path?: string | null; readonly type: "listFiles" }
  | {
      readonly command: string;
      readonly path?: string | null;
      readonly query?: string | null;
      readonly type: "search";
    }
  | { readonly command: string; readonly type: "unknown" };
```

`grep -rn "commandActions" apps packages --include=*.ts | grep -v _generated` returns exactly one
hit, in a test fixture (`apps/server/test/ActivityPayloadProjection.test.ts:79`). The adapter never
reads it. Because `data` is the verbatim `params`, **`data.item.commandActions[]` is already present
in every persisted Codex `command_execution` activity** — read / listFiles / search discriminated,
with `path` and `query`. No shell parsing needed. It is simply not whitelisted onto the wire (§5).

### 2.3 Cursor and Grok — the shared ACP path

Cursor and Grok share **100%** of the tool-call mapping code. `CursorAdapter.ts` and
`GrokAdapter.ts` contain no tool classification logic of their own; both call `makeAcpToolCallEvent`
(`CursorAdapter.ts:841`, `GrokAdapter.ts:849`) fed by `parseSessionUpdateEvent`
(`AcpRuntimeModel.ts:543-566`).

`grep -rn "toolName" apps/server/src/provider/acp/ .../CursorAdapter.ts .../GrokAdapter.ts` → **zero
hits.** `data.input` does not exist either; the field is `data.rawInput`.

Mapping — `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:47-61`:

```ts
function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}
```

| ACP `kind`                                 | itemType                                   | Recovery                                                                                    |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `execute`                                  | `command_execution`                        | `data.command` (`AcpRuntimeModel.ts:337-339`)                                               |
| `edit` / `delete` / `move`                 | `file_change`                              | `data.locations[*].path`, else `data.rawInput.*`                                            |
| `search`                                   | **`web_search`** — collides with web fetch | `data.kind === "search"` disambiguates; query in `data.rawInput.query｜pattern｜searchTerm` |
| `fetch`                                    | `web_search`                               | `data.kind === "fetch"`                                                                     |
| **`read`**                                 | `dynamic_tool_call` (default)              | **`data.kind === "read"`** + `data.locations[0].path`                                       |
| `think` / `switch_mode` / `other` / absent | `dynamic_tool_call`                        | —                                                                                           |

`data` is built by `makeToolCallState` (`AcpRuntimeModel.ts:334-353`) and its complete key set is
exactly `{ toolCallId, kind?, command?, rawInput?, rawOutput?, content?, locations? }`. Both
`rawInput` and `locations` are stored **verbatim** (`:344-352`). Emitted at
`AcpCoreRuntimeEvents.ts:184`. `ToolCallLocation` is `{ path: string; line?: number | null }`
(`packages/effect-acp/src/_generated/schema.gen.ts:660-664`).

Cross-update merge is a shallow spread (`AcpRuntimeModel.ts:420-423`), so a later
`tool_call_update` that omits `locations` does not clear an earlier one. Good for us.

**No upstream tool name is recoverable from structured fields.** ACP `tool_call` notifications carry
`title` + `kind`, not a tool name. `payload.title` is a T3-synthesised display string
(`deriveToolActivityPresentation`, `packages/shared/src/toolActivity.ts:199-261`) collapsing
everything into `"Ran command" | "Read file" | "Changed files" | "Searched files" | <passthrough>`.
Confirmed by fixture: `apps/server/scripts/acp-mock-agent.ts:726-727` sends
`title: "Read File", kind: "read"`, and `AcpJsonRpcConnection.test.ts:349` asserts
`expect(toolCall.toolCall.title).toBe("Read file")`.

`kind === "read"` **is** branched on in exactly one place, for approvals —
`AcpCoreRuntimeEvents.ts:36-37` (`case "read": return "file_read_approval";`).

**Cursor/Grok divergences (none affect tool metadata).** `CursorAcpExtension.ts` handles only
`cursor/ask_question` / `cursor/create_plan` / `cursor/update_todos`; `XAiAcpExtension.ts` handles
only `x.ai/ask_user_question` and a prompt-completion wrapper (`XAiAcpExtension.ts:203-274`,
applied at `GrokAcpSupport.ts:76`) that explicitly passes through `getEvents`
(`XAiAcpExtension.ts:225`). The one behavioural difference in the tool path: Grok drops tool-call
events belonging to interrupted turns (`GrokAdapter.ts:803-809`); Cursor does not.

**Silent-drop hazard.** A non-terminal tool-call update with no derivable `detail` is suppressed
entirely — `apps/server/src/provider/acp/AcpSessionRuntime.ts:929-940`:

```ts
if (next.status === "completed" || next.status === "failed") {
  return true;
}
if (!next.detail) {
  return false;
}
```

Since a `read` with no discoverable path yields no `detail`
(`packages/shared/src/toolActivity.ts:228-230`), such a call emits nothing until it completes. For a
visualisation this is fine (the completed event still arrives) but it rules out using in-flight
updates as the signal.

### 2.4 OpenCode — `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

Classification is `toToolLifecycleItemType` (`:286-316`), a substring ladder over the raw tool name,
with exactly one caller (`:901`).

`data` is `{ tool, state }` — **not** `{ toolName, input, result }` — `OpenCodeAdapter.ts:914-917`:

```ts
              data: {
                tool: part.tool,
                state: part.state,
              },
```

| OpenCode tool              | Matched literal                         | itemType                              | Path location                                                    |
| -------------------------- | --------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `read`                     | none                                    | `dynamic_tool_call` (`:315`)          | `data.state.input.<key>` — **UNVERIFIED** (`filePath` vs `path`) |
| `grep`                     | none                                    | `dynamic_tool_call` (`:315`)          | `data.state.input.*` — **UNVERIFIED**                            |
| `glob`                     | none                                    | `dynamic_tool_call` (`:315`)          | `data.state.input.*` — **UNVERIFIED**                            |
| `list`                     | none                                    | `dynamic_tool_call` (`:315`)          | `data.state.input.*` — **UNVERIFIED**                            |
| `bash`                     | `"bash"` (`:288`)                       | `command_execution`                   | `data.state.input.command` (shell string)                        |
| `edit` / `write` / `patch` | `"edit"｜"write"｜"patch"` (`:291-296`) | `file_change`                         | `data.state.input.*` — **UNVERIFIED**                            |
| `webfetch`                 | `"web"` (`:299`)                        | `web_search` (a fetch, not a search)  | n/a                                                              |
| `task`                     | `"task"` (`:309`)                       | `collab_agent_tool_call`              | n/a                                                              |
| `todowrite`                | `"write"` (`:293`)                      | **`file_change`** (misclassification) | n/a                                                              |

**The adapter never inspects tool input.** No `state.input`, `.filePath`, `.path`, `.pattern` access
exists anywhere in the file; `part.state` is spread wholesale at `:916` and nothing destructures it.
Only four things are read off `state`: `status` (`:903`, `:907-911`, `:928-932`), `output｜error｜title`
→ `detail` (`detailFromToolPart`, `:478-489`), `time.*` → `createdAt` (`:491-501`), and `title`.

`grep -n "isReadOnly\|readOnly\|read_only" OpenCodeAdapter.ts` → **no matches.** No analogue of
`isReadOnlyToolName`.

**UNVERIFIED — OpenCode input key names.** `@opencode-ai/sdk` (`apps/server/package.json:31`,
`^1.3.15`) is not installed in this worktree, so `ToolState`'s `input` typing could not be read.
Worse, the `part.type === "tool"` branch (`:900-937`) is **completely untested** — the only
`message.part.updated` fixtures in `OpenCodeAdapter.test.ts` are text parts (`:1096-1102`,
`:1114-1124`), and `grep -in "callid|bash|webfetch|todowrite|glob|grep"` over the 1377-line test
file returns nothing. There is no in-repo evidence of OpenCode's real tool input shape at all. This
must be settled from a live capture or the installed SDK types before writing extraction code.

### 2.5 Cross-adapter summary of `data`

| Provider | `data` shape                                                                                                  | Tool name at                               | Input at              | Structured path at                                            |
| -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------- | ------------------------------------------------------------- |
| Claude   | `{ toolName, input, result? }` (`ClaudeAdapter.ts:2361-2365`)                                                 | `data.toolName`                            | `data.input`          | `data.input.<key>` (key name UNVERIFIED)                      |
| Codex    | verbatim notification `params` (`CodexAdapter.ts:492`)                                                        | `data.item.tool` (dynamic/MCP/collab only) | `data.item.arguments` | `data.item.changes[].path`; `data.item.commandActions[].path` |
| Cursor   | `{ toolCallId, kind?, command?, rawInput?, rawOutput?, content?, locations? }` (`AcpRuntimeModel.ts:334-353`) | **absent**                                 | `data.rawInput`       | `data.locations[].path`                                       |
| Grok     | identical to Cursor                                                                                           | **absent**                                 | `data.rawInput`       | `data.locations[].path`                                       |
| OpenCode | `{ tool, state }` (`OpenCodeAdapter.ts:914-917`)                                                              | `data.tool`                                | `data.state.input`    | `data.state.input.<key>` (UNVERIFIED)                         |

---

## 3. Which adapters genuinely cannot distinguish reads

| Provider     | Can distinguish read?          | Why                                                                                                                                                                                              |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude**   | **Yes, reliably.**             | `data.toolName` is the raw upstream name; `"Read"` / `"Grep"` / `"Glob"` are exact strings. Recovering the _path_ is the weak link, not the _kind_.                                              |
| **Cursor**   | **Yes, reliably.**             | `data.kind === "read"` is verbatim ACP. `"search"` is also explicit (though it lands in `web_search`). Path from `data.locations`, **if the agent sends them** — see caveat.                     |
| **Grok**     | **Yes, reliably.**             | Same code path as Cursor, same guarantees.                                                                                                                                                       |
| **OpenCode** | **Yes, in principle.**         | `data.tool` is the raw name (`"read"`, `"grep"`, `"glob"`, `"list"`). But the _path_ lives in an input shape that is undocumented in-repo and completely untested. Kind is certain; path is not. |
| **Codex**    | **No, not at the item level.** | Codex has no read/grep/glob tool. Every read and search is a shell invocation arriving as `command_execution`. There is no tool name to test.                                                    |

**The Codex caveat that rescues it.** Codex is the only adapter that genuinely cannot classify from
tool identity — and it is also the only one that does not need to, because
`data.item.commandActions[]` already carries `{ type: "read" | "listFiles" | "search", path, query }`
per action (`schema.gen.ts:14494-14508`). So the honest statement is: _no adapter is fundamentally
blind to reads_; Codex is blind by tool name but sighted by pre-parsed command action, and the
adapter simply discards the field.

**A caveat that cuts the other way for Cursor/Grok.** `locations` is optional in ACP and is
populated by the _agent_, not by T3. No fixture anywhere in this repo uses `locations` (verified:
`grep -rn "locations" apps/server/src/provider/Layers/{Cursor,Grok}Adapter.test.ts` → 0 hits; the
only tool-call fixtures live in `apps/server/scripts/acp-mock-agent.ts` and use `kind: "read"`,
`"search"`, `"other"` with no locations). **UNVERIFIED:** whether `cursor-agent` and `grok agent`
actually populate `locations` in practice. If they don't, Cursor/Grok reads are classifiable but
pathless, and the only fallback is `data.rawInput`, whose key names are agent-defined and unknown.
This is the single biggest open question in the ticket and can only be answered by capturing a real
session.

**A cheap workaround if `locations` is empty.** For Cursor/Grok the mock agent's own convention
(`acp-mock-agent.ts:726-727`) suggests the path often appears in the human-readable `title`, and
`extractPrimaryPath` (`toolActivity.ts:134-138`) already scavenges `rawInput` for six path-like key
names. That heuristic is already in production for display purposes; reusing it for the
visualisation costs nothing but inherits its miss rate.

---

## 4. File touches that only surface inside a `command_execution` shell string

### Where this actually bites

| Provider      | Reads/searches routed through shell | Assessment                                                                                                                                                                      |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex         | **~100%**                           | No read/grep/glob tool exists. Every single one.                                                                                                                                |
| Claude        | Minority                            | `Read`/`Grep`/`Glob` are first-class and strongly preferred by the model; `cat`/`rg`/`sed`/`head` via `Bash` still occur, typically for piping, counting, or multi-file sweeps. |
| OpenCode      | Minority                            | `read`/`grep`/`glob`/`list` are first-class built-ins; `bash` is used similarly to Claude.                                                                                      |
| Cursor / Grok | Minority                            | `kind: "execute"` covers shell; `read`/`search` kinds are first-class.                                                                                                          |

**I cannot quantify the minority-provider rates from source.** Doing so honestly requires counting
`command_execution` activities whose shell string names a file against total file-touching
activities, across real threads. The data exists — `payload_json` in
`projection_thread_activities` (`apps/server/src/persistence/Migrations/005_Projections.ts:48-59`)
retains every full payload — so this is a SQL query away on any machine with a populated
`state.sqlite`, but it is not answerable by reading code. Flagging rather than inventing a number.

### Judgement: is parsing shell strings worth it?

**For Codex: no — and you don't have to.** Parsing `rg -n 'foo' src/` out of a string when
`commandActions[0] = { type: "search", path: "src/", query: "foo" }` sits two keys away in the same
payload would be strictly worse in every dimension. **Recommendation: extend
`projectCommandData`/the projection whitelist to pass `commandActions` through, and read it.** This
converts Codex from the worst-supported provider to arguably the best — it is the only provider
giving you a typed read/list/search discriminator _with_ a path, produced by the agent's own
sandbox-aware parser.

**For the other four: no, not in v1.** The cost/benefit is bad:

- Shell strings are adversarial to parse: pipes, `&&`, subshells, `xargs`, quoting, globs that
  expand to N files, `for` loops, heredocs. A parser good enough to avoid false positives on the
  visualisation (which colours a file "read" and thereby lies to the user) is a real piece of work.
- The failure mode is asymmetric. A missed read leaves a node moss-coloured — the user reads it as
  "not visited yet", which is a mild, self-correcting error. A false read paints a node blue and the
  user trusts a touch that never happened. Cheap-and-wrong is worse than nothing here.
- The marginal gain is bounded by the minority share, which we haven't measured.

**A narrow exception worth taking.** A conservative allowlist over the _first_ token of the command
only — `cat`, `head`, `tail`, `less`, `bat`, `wc -l` for reads; `rg`, `grep`, `ag` for searches;
`ls`, `fd`, `find` for globs — with a hard bail on any string containing `|`, `>`, `;`, `&&`, `$(`,
or a backtick, would capture the common single-purpose invocation at near-zero false-positive risk
and about 40 lines of code. Treat it as an optional enhancement gated behind the measurement above,
not part of the core classifier.

---

## 5. The two caps — verified

### 5.1 `truncateDetail` (180 chars) — affects `detail` ONLY. Not a concern.

`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:203-205` (note: in
`orchestration/Layers/`, not `provider/`):

```ts
function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}
```

Signature is `(value: string) => string`; it is statically incapable of touching an object. All 14
call sites pass a `detail` / `summary` / `message` / `description` / `title` string (lines 384, 403,
421, 423, 505, 523, 528, 530, 531, 557, 562, 563, 630, 652, 674 — the 120-char variants are the
`summary`/`title` ones). The three tool-lifecycle cases spread `data` in raw alongside the truncated
`detail` — `ProviderRuntimeIngestion.ts:650-654`:

```ts
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
```

`data` is passed **by reference, unwrapped, uncloned, unmeasured**. Same at `:627-632`
(`item.updated`); `item.started` (`:672-675`) carries no `data`.

**Verdict: the 180-char cap does not affect `data` and needs no routing around.** It only matters if
you were planning to parse paths out of `detail` — which you should not, for exactly this reason.

### 5.2 `collectChangedFiles` (12 files / depth 4) — real, but the _enclosing_ function is the actual problem

`apps/server/src/orchestration/ActivityPayloadProjection.ts:30-81`. Entry guard at `:36`
(`if (depth > 4 || target.length >= 12) return;`), re-checked after each array element (`:42`) and
each nested key (`:77`). It reads six path-like keys (`:54-59`) and recurses into ten whitelisted
nested keys (`:61-72`): `item, result, input, data, changes, files, edits, patch, patches,
operations`. Note `locations` is **not** in that list (it _is_ in the parallel walker at
`packages/shared/src/toolActivity.ts:123`) — so Cursor/Grok `data.locations[].path` is **not**
collected by `collectChangedFiles`. Nor is any snake_case key.

`collectChangedFiles` itself mutates nothing. But the framing in the ticket — "`changedFiles` is a
derived field alongside an untouched `data`" — is **wrong**, and this is the finding that matters
most for the port. `projectActivityPayload` **replaces `data` wholesale with a whitelist**
(`ActivityPayloadProjection.ts:158-201`):

```ts
const projectedData: Record<string, unknown> = {};
const item = projectCommandData(data);
if (item) {
  projectedData.item = item;
}
if ("command" in data) {
  projectedData.command = data.command;
}
const changedFiles: string[] = [];
collectChangedFiles(data, changedFiles, new Set<string>(), 0);
if (changedFiles.length > 0) {
  projectedData.files = changedFiles.map((path) => ({ path }));
}
if ("toolCallId" in data) {
  projectedData.toolCallId = data.toolCallId;
}
if ("kind" in data) {
  projectedData.kind = data.kind;
}
const rawOutput = projectRawOutput(data.rawOutput);
if (rawOutput) {
  projectedData.rawOutput = rawOutput;
}
return { ...activity, payload: { ...payload, data: projectedData } };
```

The surviving keys are exactly **`item`** (itself narrowed by `projectCommandData` `:83-105` to only
`command`, `input.command`, `result.command`), **`command`**, **`files`** (≤12 derived paths),
**`toolCallId`**, **`kind`**, and **`rawOutput`** (narrowed to `{ totalFiles, truncated? }` or one
≤84-char summary line, `:107-152`). Escape hatch: `itemType === "mcp_tool_call"` returns the
activity untouched (`:163-165`).

Consequences per provider on the wire today:

- Claude: `data.toolName` **dropped**, `data.input` **dropped**. Only `files` survives — and per §2.1
  it probably captures Grep's search root while missing Edit's target.
- Codex: `data.item` narrowed to command strings; `commandActions` **dropped**; `changes[].path`
  survives only via `files`.
- Cursor/Grok: `data.kind` **survives** (`:186-188`). `data.locations[].path` is **dropped**: the
  root call is already `data`, and the loop descends only into the ten whitelisted nested keys, so
  a top-level `locations` array is never traversed at all (§5.2). `data.rawInput` **dropped**.
  Only `kind` survives — enough to classify the touch, not to name the file.
- OpenCode: `data.tool` **dropped**, `data.state` **dropped**. Essentially nothing survives.

**Where the stripping applies.** Only at the read/wire boundary — `apps/server/src/ws.ts:1266`
(live), `:1311` (catch-up replay), `:1368` (snapshot), and `apps/server/src/orchestration/http.ts:78`.
The full payload is retained in SQLite (`payload_json TEXT`, no size cap,
`Migrations/005_Projections.ts:48-59`; write is a plain `JSON.stringify` at
`apps/server/src/persistence/Layers/ProjectionThreadActivities.ts:58`) and in the event store
(`OrchestrationEventStore.ts:32,45`). This is exactly what the doc comment at
`ActivityPayloadProjection.ts:154-157` claims.

**Verdicts:**

- The **12-file cap** is real but almost certainly not the binding constraint: a single tool call
  touching >12 files is rare outside a large `MultiEdit` or a `Task` rollup. Raise it if it shows up
  in practice; don't pre-optimise.
- The **depth-4 cap** is closer to binding. Codex's paths sit at `data → item → changes → [i] → path`,
  which is depth 4 exactly (array iteration consumes a level at `:41`). Codex `commandActions[].path`
  would be at the same depth. Any deeper nesting silently yields nothing, with no diagnostic.
- **The whitelist is the binding constraint.** Neither cap matters until `projectedData` carries the
  keys a classifier needs.

### 5.3 Other limits found on the path (none block this work)

- `apps/server/src/orchestration/projector.ts:743` — in-memory read model keeps the last **500**
  activities per thread (`.slice(-500)`). The SQL projection has no `LIMIT`.
- `summarizeToolTextOutput` truncates to 84 chars (`ActivityPayloadProjection.ts:118`).
- `MAX_BUFFERED_ASSISTANT_CHARS = 24_000` (`ProviderRuntimeIngestion.ts:94`) — a spill valve, flushes
  rather than drops.
- `THREAD_RESUME_MAX_GAP = 1_000` (`ws.ts:306`) — beyond that, a fresh snapshot replaces replay.
- Activity coalescing in `ws.ts:677-746` applies to the **shell** stream only; thread activity events
  are mapped 1:1.
- **No** max-payload-bytes guard, **no** deep clone, **no** closed-struct schema decode anywhere
  between adapter and `payload_json`.

---

## 6. Recommended classification function

### 6.1 Prior art to reuse, not duplicate

`packages/shared/src/toolActivity.ts` already contains 80% of this:

- `classifyToolAction` (`:157-184`) returns `"command" | "read" | "file_change" | "search" | "other"`
  from `{ itemType, title, data }` — the shape this ticket asks for, minus the paths.
- `extractPrimaryPath` / `collectPaths` (`:95-138`) walks `locations, item, input, result, rawInput,
data, changes` for `path, filePath, relativePath, filename, newPath, oldPath`, with
  `maybePathLike` (`:80-93`) filtering non-path strings.
- It is already shared between web and mobile, and already runs on the _projected_ payload.

`classifyToolAction`'s current heuristics are ACP-shaped (`kind === "read"`, `title === "read file"`)
and therefore work for Cursor/Grok and nothing else. **The right move is to widen this function
rather than write a sixth path-walker.**

### 6.2 Proposed signature

Place in `packages/shared/src/toolActivity.ts` (shared by web, mobile, and any future viz surface):

```ts
export type FileTouchKind = "searched" | "read" | "edited" | "executed" | "none";

export interface FileTouch {
  /** What the tool call did to `paths`. */
  readonly kind: FileTouchKind;
  /**
   * Absolute or workspace-relative paths, in the order discovered. May be empty
   * even when `kind !== "none"` — a classified-but-pathless touch. Callers must
   * handle that (see `confidence`).
   */
  readonly paths: ReadonlyArray<string>;
  /**
   * `exact`  — kind and paths both came from a typed field (Claude toolName +
   *            input, Codex commandActions, ACP kind + locations, OpenCode tool
   *            + state.input).
   * `heuristic` — kind is typed but paths came from a generic key walk, or the
   *            kind was inferred from a title/detail string.
   * `none`   — nothing usable.
   *
   * The visualisation should render `heuristic` touches differently (or behind a
   * toggle): a false "read" is worse than a missing one.
   */
  readonly confidence: "exact" | "heuristic" | "none";
  /** For `searched`: the query/pattern, when recoverable. Useful as a tooltip. */
  readonly query?: string;
}

export function classifyFileTouch(activity: OrchestrationThreadActivity): FileTouch;
```

Taking the whole `OrchestrationThreadActivity` (not just `payload.data`) is right: `kind`
(`"tool.completed"` etc.) and `turnId` are both needed — `turnId` in particular, because mindwalk's
ramp is temporal and needs to age touches by turn.

**De-duplication belongs to the caller, not this function.** Claude emits `data` on up to three
events per tool call (`item.started`, streaming `item.updated`, `item.completed`), so a naive
per-activity fold triple-counts. Filter to `activity.kind === "tool.completed"` before folding, or
dedupe on `itemId`.

### 6.3 Per-provider reliability notes to embed as doc comments

| Provider     | `kind` reliability                                                                                   | `paths` reliability                                                                                                                        | Notes                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude**   | Exact — `data.toolName` is the upstream name                                                         | **At risk.** If the input key is `file_path`, no existing walker finds it, and `Read`/`Edit` paths are invisible. Confirm before shipping. | Also: `Grep`'s `input.path` is a _search root_, not a file. Emitting it as a touched file would paint whole directories. Treat `Grep`/`Glob` paths as scope hints, not touches — prefer paths from the tool _result_. |
| **Codex**    | **`none` until `commandActions` is whitelisted.** After that: exact for `read`/`listFiles`/`search`. | Exact (`commandActions[].path` is an `AbsolutePathBuf`).                                                                                   | `file_change` paths at `data.item.changes[].path` are exact today. The `command_execution` → read/search classification is entirely blocked on the projection change.                                                 |
| **Cursor**   | Exact via `data.kind` (survives projection).                                                         | **Unknown.** Depends on whether `cursor-agent` populates `locations`. No in-repo fixture uses it.                                          | `kind: "search"` arrives as `itemType: "web_search"` — do **not** branch on `itemType` for search; branch on `kind` first and treat `itemType` as a fallback.                                                         |
| **Grok**     | Exact via `data.kind`.                                                                               | **Unknown**, same as Cursor.                                                                                                               | Additionally, Grok drops tool-call events for interrupted turns (`GrokAdapter.ts:803-809`), so an interrupted turn's touches are simply absent.                                                                       |
| **OpenCode** | Exact via `data.tool` — **but `data.tool` is dropped by the projection.**                            | **Unknown** — no SDK types, no test fixtures, zero in-repo evidence.                                                                       | The worst-supported provider. Everything here needs a live capture first.                                                                                                                                             |

### 6.4 Ordered next steps

1. **Widen the projection whitelist** (`ActivityPayloadProjection.ts:167-193`). This is the gate on
   everything else. Minimum additions: `toolName`, `tool`, `kind` (already there), `locations`, and a
   path-and-kind-only narrowing of `input` / `rawInput` / `state.input` / `item.commandActions`. Keep
   it a narrowing, not a passthrough — the whole point of the projection is wire size, and dumping
   raw `input` would ship whole file contents for `Write` calls.
2. **Capture one real session per provider** and record the actual `payload.data` for a read, a
   grep, a glob, and an edit. Three of the five providers have material unknowns that only a capture
   settles (Claude's key casing, Cursor/Grok `locations`, all of OpenCode).
3. **Add `commandActions` to the Codex path.** Single highest-value change; converts Codex from
   unclassifiable to exact.
4. **Widen `classifyToolAction` into `classifyFileTouch`** in `packages/shared/src/toolActivity.ts`,
   with unit tests per provider driven by the captures from step 2. Note that `OpenCodeAdapter.ts`'s
   entire tool branch (`:900-937`) is currently untested — worth adding fixtures there regardless.
5. **Measure the shell-string share** before writing any command parser (§4).

---

## Appendix: negative findings (things that do not exist)

Each verified by grep over the worktree, excluding `node_modules`:

- `data.toolName` exists **only** in `ClaudeAdapter.ts`. Zero hits in `Codex*.ts`, in
  `apps/server/src/provider/acp/`, in `CursorAdapter.ts`, or in `GrokAdapter.ts`. `OpenCodeAdapter.ts`
  uses `toolName` only as a function parameter name (`:286-287`).
- `file_path` (snake_case): zero hits across `apps/server/src`, `packages/shared/src`,
  `packages/contracts/src`.
- `commandActions`: zero hits in adapter source; one hit in a test fixture
  (`apps/server/test/ActivityPayloadProjection.test.ts:79`).
- `isReadOnlyToolName`: exists only at `ClaudeAdapter.ts:640`, used only at `:653` for approvals.
- ACP `case "read":` for _item typing_: does not exist. The only `case "read":` in
  `apps/server/src/provider/acp/` is `AcpCoreRuntimeEvents.ts:36`, inside the approval mapper.
- No Cursor or Grok adapter test exercises a tool-call payload
  (`grep -n "rawInput\|locations\|toolCallId\|tool_call"` over both `.test.ts` files → 0 hits).
- No OpenCode test constructs a tool part; the `part.type === "tool"` branch is entirely uncovered.
- Codex has zero item-classification tests for `commandExecution`, `fileChange`, `dynamicToolCall`,
  `collabAgentToolCall`, `webSearch`, or `imageView`.
- No max-payload-bytes guard, `JSON.stringify` length check, deep clone, or closed-struct schema
  decode exists anywhere between an adapter's emit and `payload_json`.
