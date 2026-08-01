/**
 * ProviderTraceAdapter - reshaping one T3 activity into mindwalk's tool call.
 *
 * This is the whole provider-shaped surface of the trace projection. Everything
 * downstream — `TraceEvent`, `TraceStats`, the scenes — speaks mindwalk's
 * `{ tool, input, result }` vocabulary and never learns which provider produced
 * it, the same boundary mindwalk draws between `internal/adapter/<harness>` and
 * its shared `adapter.go`. Adding a provider is adding an entry here.
 *
 * ## Confidence, per provider
 *
 * - **Claude** and **Codex** are verified against real rows in this
 *   environment's store, and are the two the developer actually runs.
 * - **Cursor / Grok (ACP)** and **OpenCode** are written from source (see
 *   `docs/internals/research/provider-tool-call-classification.md`) and have
 *   never been observed live. They deliberately fall back to "touched, kind
 *   unknown" rather than throwing or dropping, so a wrong guess costs a dimmer
 *   building rather than a broken trace. No test asserts their behaviour beyond
 *   that fallback.
 *
 * @module ProviderTraceAdapter
 */
import type { SeedTarget, ToolCall, ToolResult } from "./TraceEvent.ts";
import { contentToString } from "./TraceEvent.ts";
import type { ObservabilityGrade } from "./TraceStats.ts";

/** One `tool.completed` activity, as stored. */
export interface ToolActivityPayload {
  readonly itemType?: string;
  readonly detail?: string;
  readonly data?: unknown;
}

export interface AdaptedCall {
  readonly call: ToolCall;
  readonly result: ToolResult;
}

export interface ProviderTraceAdapter {
  /** mindwalk's `harness` string for this provider. */
  readonly harness: string;
  /**
   * Whether this provider flags tool failures structurally. Both providers in
   * use do — Claude with `result.is_error`, Codex with `status`/`exitCode` —
   * so neither has to sniff error text the way mindwalk's own Codex adapter
   * does when reading rollout JSONL.
   */
  readonly errorSignal: ObservabilityGrade;
  /** Reshape a completed tool call, or return null to drop it from the trace. */
  readonly adapt: (payload: ToolActivityPayload) => AdaptedCall | null;
  /** This call's own id, so a lens can match a subagent launch against it. */
  readonly callId: (payload: ToolActivityPayload) => string | null;
}

/**
 * Claude's stored payload already *is* mindwalk's shape —
 * `{ toolName, input, result: { content, is_error } }` — with snake_case
 * `file_path`, which is exactly what `targetsFor` reads. So the adapter is
 * barely an adapter, and the tool names are the upstream names mindwalk's
 * switch was written against.
 */
const claudeAdapter: ProviderTraceAdapter = {
  harness: "claude-code",
  errorSignal: "exact",
  adapt: (payload) => {
    const data = asRecord(payload.data);
    if (data === null) return null;
    const tool = asString(data["toolName"]);
    if (tool === null) return null;
    const result = asRecord(data["result"]);
    return {
      call: { tool, input: asRecord(data["input"]) ?? {} },
      result: {
        content: contentToString(result?.["content"]),
        isError: result?.["is_error"] === true,
      },
    };
  },
  callId: (payload) => {
    const result = asRecord(asRecord(payload.data)?.["result"]);
    return asString(result?.["tool_use_id"]);
  },
};

/**
 * Codex has no read, grep or glob tool — the agent shells out for everything,
 * so every touch arrives as a `commandExecution`. What rescues it is
 * `commandActions[]`, which Codex's own sandbox-aware parser fills in with
 * `{ type: "read" | "listFiles" | "search", path }` and which T3 has been
 * storing and ignoring.
 *
 * Those seeded targets are **not weak**, which is the one deliberate deviation
 * from mindwalk: upstream marks every Codex target weak because shell strings
 * are all it has, whereas we have a typed discriminator with an absolute path.
 * Marking it weak would report "estimated" read confidence on every Codex
 * thread — precisely the lie that grade exists to prevent.
 */
const codexAdapter: ProviderTraceAdapter = {
  harness: "codex",
  errorSignal: "exact",
  adapt: (payload) => {
    const data = asRecord(payload.data);
    const item = asRecord(data?.["item"]);
    if (item === null) return null;

    switch (payload.itemType) {
      case "command_execution": {
        const command = asString(item["command"]) ?? "";
        const workdir = asString(item["cwd"]) ?? "";
        const exitCode = item["exitCode"];
        return {
          call: {
            tool: "exec_command",
            input: { cmd: command, ...(workdir !== "" ? { workdir } : {}) },
            seeds: commandActionSeeds(item["commandActions"], workdir),
          },
          result: {
            content: asString(item["aggregatedOutput"]) ?? "",
            isError:
              item["status"] === "failed" || (typeof exitCode === "number" && exitCode !== 0),
          },
        };
      }
      case "file_change": {
        // Codex names the changed files structurally, so there is no patch
        // envelope to parse — `apply_patch` is only here to select the "edit"
        // action out of mindwalk's switch.
        const seeds = asArray(item["changes"]).flatMap((change): Array<SeedTarget> => {
          const path = asString(asRecord(change)?.["path"]);
          return path === null ? [] : [{ path, touch: "edit" }];
        });
        return {
          call: { tool: "apply_patch", input: {}, seeds },
          result: { content: "", isError: item["status"] === "failed" },
        };
      }
      case "image_view": {
        const path = asString(item["path"]);
        return {
          call: { tool: "view_image", input: path === null ? {} : { path } },
          result: { content: "", isError: false },
        };
      }
      default: {
        // Everything else — MCP calls, dynamic tools, web search, subagent
        // launches — is a real event on the histogram with no file targets,
        // which is what mindwalk shows for them too.
        const tool = asString(item["tool"]) ?? payload.itemType ?? "unknown";
        return {
          call: { tool, input: asRecord(item["arguments"]) ?? {} },
          result: { content: "", isError: item["status"] === "failed" },
        };
      }
    }
  },
  callId: (payload) => asString(asRecord(asRecord(payload.data)?.["item"])?.["id"]),
};

/**
 * Cursor and Grok share one ACP path. `kind` is verbatim ACP and is the only
 * classification signal — there is no tool name on the wire at all — while
 * paths come from `locations[]`, which the *agent* populates and may omit.
 *
 * Note ACP maps `kind: "search"` (a codebase grep) and `kind: "fetch"` (a web
 * fetch) onto the same `web_search` item type, so `kind` is what tells them
 * apart. **Unverified against a live session.**
 */
const acpAdapter = (harness: string): ProviderTraceAdapter => ({
  harness,
  errorSignal: "estimated",
  adapt: (payload) => {
    const data = asRecord(payload.data);
    if (data === null) return null;
    const kind = asString(data["kind"]) ?? "";
    const locations = asArray(data["locations"]).flatMap((location) => {
      const path = asString(asRecord(location)?.["path"]);
      return path === null ? [] : [path];
    });
    const [primary] = locations;

    switch (kind) {
      case "read":
        return {
          call: { tool: "Read", input: primary === undefined ? {} : { file_path: primary } },
          result: { content: contentToString(data["rawOutput"]), isError: false },
        };
      case "edit":
      case "delete":
      case "move":
        return {
          call: {
            tool: "Edit",
            input: primary === undefined ? {} : { file_path: primary },
            seeds: locations.slice(1).map((path) => ({ path, touch: "edit" }) as const),
          },
          result: { content: "", isError: false },
        };
      case "search":
        return {
          call: {
            tool: "Grep",
            input: {},
            seeds: locations.map((path) => ({ path, touch: "hit" }) as const),
          },
          result: { content: contentToString(data["rawOutput"]), isError: false },
        };
      case "execute":
        return {
          call: { tool: "Bash", input: { command: asString(data["command"]) ?? "" } },
          result: { content: contentToString(data["rawOutput"]), isError: false },
        };
      default:
        // Touched, kind unknown: keep the event on the histogram and seed
        // whatever paths the agent volunteered, at the weakest touch level.
        return {
          call: {
            tool: kind === "" ? "unknown" : kind,
            input: {},
            seeds: locations.map((path) => ({ path, touch: "hit" }) as const),
          },
          result: { content: contentToString(data["rawOutput"]), isError: false },
        };
    }
  },
  callId: (payload) => asString(asRecord(payload.data)?.["toolCallId"]),
});

/**
 * OpenCode stores `{ tool, state }` with the raw lowercase tool name. The name
 * is certain; the input key holding the path is not documented anywhere in this
 * repo, so paths are scavenged across the plausible spellings.
 * **Unverified against a live session.**
 */
const OPENCODE_TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  list: "LS",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  patch: "Edit",
};

const openCodeAdapter: ProviderTraceAdapter = {
  harness: "opencode",
  errorSignal: "estimated",
  adapt: (payload) => {
    const data = asRecord(payload.data);
    if (data === null) return null;
    const rawTool = asString(data["tool"]) ?? "";
    const tool = OPENCODE_TOOL_NAMES[rawTool.toLowerCase()] ?? rawTool;
    const state = asRecord(data["state"]) ?? {};
    const stateInput = asRecord(state["input"]) ?? {};
    const path = firstPathLike(stateInput);

    return {
      call: {
        tool: tool === "" ? "unknown" : tool,
        input: {
          ...stateInput,
          // mindwalk's switch reads `file_path` and `command`; OpenCode's own
          // key names are unverified, so normalise into those two.
          ...(path !== null ? { file_path: path } : {}),
          ...(typeof stateInput["command"] === "string" ? { command: stateInput["command"] } : {}),
        },
      },
      result: {
        content: contentToString(state["output"]),
        isError: state["status"] === "error" || typeof state["error"] === "string",
      },
    };
  },
  callId: (payload) => asString(asRecord(asRecord(payload.data)?.["state"])?.["id"]),
};

/**
 * Falls back to whichever adapter the payload's own shape matches, for a thread
 * whose provider we could not name — a future provider, or a row whose session
 * has been cleaned up.
 *
 * Guessing by shape beats defaulting to one provider: reading a Claude payload
 * with the ACP adapter finds nothing at all and renders a dark, empty city,
 * which looks like "the agent touched nothing" rather than like a failure.
 */
const shapeSniffingAdapter = (harness: string): ProviderTraceAdapter => {
  const pick = (payload: ToolActivityPayload): ProviderTraceAdapter => {
    const data = asRecord(payload.data);
    if (data === null) return acpAdapter(harness);
    if (typeof data["toolName"] === "string") return claudeAdapter;
    if (asRecord(data["item"]) !== null) return codexAdapter;
    if (typeof data["tool"] === "string") return openCodeAdapter;
    return acpAdapter(harness);
  };
  return {
    harness,
    errorSignal: "estimated",
    adapt: (payload) => pick(payload).adapt(payload),
    callId: (payload) => pick(payload).callId(payload),
  };
};

/** The adapter for a thread's provider. */
export function adapterFor(providerName: string | null | undefined): ProviderTraceAdapter {
  switch (providerName) {
    case "claudeAgent":
      return claudeAdapter;
    case "codex":
      return codexAdapter;
    case "cursor":
      return acpAdapter("cursor");
    case "grok":
      return acpAdapter("grok");
    case "opencode":
      return openCodeAdapter;
    default:
      return shapeSniffingAdapter(providerName ?? "unknown");
  }
}

/**
 * A denied tool call. The shape is provider-independent — T3 records the tool
 * name and nothing else — and mindwalk renders a rejected call the same way:
 * an error event that touched nothing.
 */
export function adaptDenial(payload: unknown): AdaptedCall | null {
  const record = asRecord(payload);
  const tool = asString(record?.["toolName"]);
  if (tool === null) return null;
  return { call: { tool, input: {} }, result: { content: "", isError: true } };
}

function commandActionSeeds(value: unknown, workdir: string): Array<SeedTarget> {
  const seeds: Array<SeedTarget> = [];
  for (const action of asArray(value)) {
    const record = asRecord(action);
    const path = asString(record?.["path"]);
    if (path === null || path === "") continue;
    const type = record?.["type"];
    // `unknown` is Codex telling us it could not parse the command; those fall
    // through to the scraping path rather than claiming a typed touch.
    if (type === "read") seeds.push({ path, touch: "read", base: workdir });
    else if (type === "listFiles" || type === "search") {
      seeds.push({ path, touch: "hit", base: workdir });
    }
  }
  return seeds;
}

const PATH_LIKE_KEYS = ["file_path", "filePath", "path", "relativePath", "filename", "newPath"];

function firstPathLike(input: Record<string, unknown>): string | null {
  for (const key of PATH_LIKE_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
