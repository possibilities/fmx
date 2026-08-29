import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import * as z from "zod/v4"
import { VERSION } from "./cli.ts"
import type { AgentInfo, SubagentInfo } from "./control-protocol.ts"
import {
  RuntimeClient,
  RuntimeRequestError,
  type RuntimeRequester,
} from "./runtime-client.ts"

const subagentSchema: z.ZodType<SubagentInfo> = z.lazy(() =>
  z.object({
    session_id: z.string(),
    label: z.string(),
    state: z.enum(["blocked", "working", "done", "idle", "unknown"]),
    attention: z.enum(["permission", "question", "route_recovery"]).nullable(),
    children: z.array(subagentSchema),
  }),
)

const agentSchema: z.ZodType<AgentInfo> = z.object({
  agent_id: z.string(),
  id: z.number().int(),
  display_id: z.number().int(),
  pane_id: z.string(),
  created_at: z.number(),
  cwd: z.string(),
  project: z.string(),
  git_root: z.string().nullable(),
  main_git_root: z.string().nullable(),
  branch: z.string().nullable(),
  worktree: z.boolean().nullable(),
  name: z.string().nullable(),
  session_id: z.string().nullable(),
  label: z.string(),
  state: z.enum(["blocked", "working", "done", "idle", "unknown"]),
  attention: z.enum(["permission", "question", "route_recovery"]).nullable(),
  active: z.boolean(),
  subagents: z.array(subagentSchema),
})

const traySchema = z.object({
  visible: z.boolean(),
  hidden: z.boolean(),
  width: z.number().int(),
})

const orientationSchema = z.object({
  fmx: z.object({
    pid: z.number().int(),
    version: z.string(),
    cwd: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
  }),
  you: agentSchema.nullable(),
  active: z.number().int().nullable(),
  agents: z.array(agentSchema),
  tray: traySchema.extend({
    rows: z.array(z.object({
      kind: z.enum(["project", "branch", "agent", "subagent"]),
      depth: z.number().int(),
      text: z.string(),
      agent: z.number().int().nullable(),
      active: z.boolean(),
    })),
  }),
  surface: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("help") }),
    z.object({ kind: z.literal("error"), heading: z.string(), message: z.string() }),
  ]),
})

const queuedWorkSchema = z.object({
  turn_id: z.string(),
  kind: z.enum(["queued", "steering"]),
  text: z.string(),
  has_images: z.boolean(),
  has_skill_bindings: z.boolean(),
  has_review_draft: z.boolean(),
})

const workSchema = z.object({
  active_turn_id: z.string().nullable(),
  queue_paused: z.boolean(),
  queue: z.array(queuedWorkSchema),
})

const agentWorkSchema = z.object({
  agent: agentSchema,
  work: workSchema,
})

const agentWorkAdmissionSchema = agentWorkSchema.extend({
  turn_id: z.string(),
  disposition: z.enum(["queued", "steering"]),
})

const toolErrorSchema = z.object({
  code: z.enum([
    "invalid_request",
    "unknown_method",
    "invalid_params",
    "not_found",
    "ambiguous",
    "busy",
    "failed",
    "timeout",
    "cancelled",
    "shutting_down",
  ]),
  message: z.string(),
  data: z.unknown().optional(),
})

/** The high-level MCP SDK requires an object output schema. Keep the success
 * fields typed, make them optional only at the advertised envelope, then
 * enforce either the complete success object or one structured error. */
const toolResultSchema = <T extends z.ZodRawShape>(success: z.ZodObject<T>) =>
  success.partial().extend({ error: toolErrorSchema.optional() }).refine(
    (result) => ("error" in result && result.error !== undefined) || success.safeParse(result).success,
    { message: "fmx tool result is neither a complete success nor an error" },
  )

const targetDescription =
  "Stable agent_id (preferred), display id, pane_id, current, active, next, previous, exact session name, or unique session-id prefix."

const targetInput = z.string().min(1).optional().describe(`${targetDescription} Defaults to current.`)
const workTextInput = z.string().min(1).describe("Plain-text work for Fx to admit through its native worker queue.")
const turnIdInput = z.string().regex(/^[1-9]\d*$/u).describe("Opaque decimal turn_id returned by Fx.")

export function createFmxMcpServer(requester: RuntimeRequester = new RuntimeClient()): McpServer {
  const server = new McpServer(
    { name: "fmx", version: VERSION },
    {
      instructions:
        "Inspect and control the running fmx Runtime. Create Agents and interact with their work only through Fx-native queue, steer, interrupt, and queued-work operations.",
    },
  )

  server.registerTool(
    "get_orientation",
    {
      title: "Get fmx orientation",
      description:
        "Read the caller, active Agent, every Agent and subagent, Tray tree, terminal dimensions, and open fmx surface.",
      outputSchema: toolResultSchema(orientationSchema),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (extra) => runTool(() => requester.request("orient", {}, extra.signal)),
  )

  server.registerTool(
    "create_agent",
    {
      title: "Create an fmx Agent",
      description:
        "Create an Fx Agent in a repository. With no directory, use the caller's repository, then the first configured project. Creation stays in the background unless it is the first Agent.",
      inputSchema: {
        directory: z.string().min(1).optional().describe("Repository directory. Absolute, relative to the Runtime, or ~/..."),
        worktree: z.boolean().optional().describe("Create a new fmx-managed git Worktree before starting Fx."),
        model: z.string().min(1).optional().describe("FX_MODEL override for this Agent only."),
        effort: z.string().min(1).optional().describe("FX_EFFORT override for this Agent only."),
      },
      outputSchema: toolResultSchema(z.object({ agent: agentSchema })),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ directory, worktree, model, effort }, extra) =>
      runTool(() => requester.request("agent.create", {
        ...(directory === undefined ? {} : { directory }),
        ...(worktree === undefined ? {} : { worktree }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      }, extra.signal)),
  )

  server.registerTool(
    "focus_agent",
    {
      title: "Focus an fmx Agent",
      description: "Select the Agent shown on the shared fmx surface. Refuses while a modal is open.",
      inputSchema: {
        target: z.string().min(1).describe(targetDescription),
      },
      outputSchema: toolResultSchema(z.object({
        agent: agentSchema,
      })),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target }, extra) => runTool(() => requester.request("focus", { target }, extra.signal)),
  )

  server.registerTool(
    "configure_tray",
    {
      title: "Configure the fmx Tray",
      description: "Read or change the shared Session list's persisted width and visibility.",
      inputSchema: z.object({
        width: z.number().int().min(1).optional().describe("Requested Tray width; fmx clamps it to the current screen."),
        hidden: z.boolean().optional().describe("True hides the Tray; false shows it when Agents exist."),
        toggle: z.boolean().optional().describe("True reverses the current hidden state."),
      }).refine(
        ({ hidden, toggle }) => hidden === undefined || toggle !== true,
        { message: "hidden and toggle cannot be combined" },
      ),
      outputSchema: toolResultSchema(traySchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ width, hidden, toggle }, extra) =>
      runTool(() => requester.request("tray", {
        ...(width === undefined ? {} : { width }),
        ...(hidden === undefined ? {} : { hidden }),
        ...(toggle === undefined ? {} : { toggle }),
      }, extra.signal)),
  )

  server.registerTool(
    "get_agent_work",
    {
      title: "Get an Agent's work",
      description:
        "Read Fx's authoritative active turn, paused state, and native FIFO of queued and steering work.",
      inputSchema: { target: targetInput },
      outputSchema: toolResultSchema(agentWorkSchema),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target }, extra) => runTool(() => requester.request(
      "work.snapshot",
      target === undefined ? {} : { target },
      extra.signal,
    )),
  )

  server.registerTool(
    "queue_agent_work",
    {
      title: "Queue work for an Agent",
      description: "Append plain-text work to the Agent's native Fx queue without steering the active turn.",
      inputSchema: { target: targetInput, text: workTextInput },
      outputSchema: toolResultSchema(agentWorkAdmissionSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target, text }, extra) => runTool(() => requester.request(
      "work.queue",
      { ...(target === undefined ? {} : { target }), text },
      extra.signal,
    )),
  )

  server.registerTool(
    "steer_agent",
    {
      title: "Steer an Agent",
      description:
        "Admit plain-text work through Fx's native steering path. Fx reports whether it steered an active turn or queued the work because no turn was active.",
      inputSchema: { target: targetInput, text: workTextInput },
      outputSchema: toolResultSchema(agentWorkAdmissionSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target, text }, extra) => runTool(() => requester.request(
      "work.steer",
      { ...(target === undefined ? {} : { target }), text },
      extra.signal,
    )),
  )

  server.registerTool(
    "interrupt_agent",
    {
      title: "Interrupt an Agent",
      description:
        "Interrupt the Agent's active main work through Fx. Any queued work is paused for inspection and remains available to update, delete, or resume.",
      inputSchema: { target: targetInput },
      outputSchema: toolResultSchema(agentWorkSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target }, extra) => runTool(() => requester.request(
      "work.interrupt",
      target === undefined ? {} : { target },
      extra.signal,
    )),
  )

  server.registerTool(
    "update_queued_work",
    {
      title: "Update queued Agent work",
      description:
        "Replace the plain text of one queued Fx turn. Fx refuses entries that carry images, skill bindings, or a native review draft.",
      inputSchema: { target: targetInput, turn_id: turnIdInput, text: workTextInput },
      outputSchema: toolResultSchema(agentWorkSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target, turn_id, text }, extra) => runTool(() => requester.request(
      "queue.update",
      { ...(target === undefined ? {} : { target }), turn_id, text },
      extra.signal,
    )),
  )

  server.registerTool(
    "delete_queued_work",
    {
      title: "Delete queued Agent work",
      description: "Delete one queued Fx turn by its opaque turn_id.",
      inputSchema: { target: targetInput, turn_id: turnIdInput },
      outputSchema: toolResultSchema(agentWorkSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target, turn_id }, extra) => runTool(() => requester.request(
      "queue.delete",
      { ...(target === undefined ? {} : { target }), turn_id },
      extra.signal,
    )),
  )

  server.registerTool(
    "resume_agent_queue",
    {
      title: "Resume an Agent's queue",
      description: "Resume Fx's paused native queue unchanged after interruption or queue review.",
      inputSchema: { target: targetInput },
      outputSchema: toolResultSchema(agentWorkSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target }, extra) => runTool(() => requester.request(
      "queue.resume",
      target === undefined ? {} : { target },
      extra.signal,
    )),
  )

  return server
}

async function runTool(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await call()
    if (!isRecord(result)) throw new Error("fmx returned an unexpected result")
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  } catch (error) {
    const failure = error instanceof RuntimeRequestError
      ? error.error
      : { code: "failed", message: error instanceof Error ? error.message : String(error) }
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: failure }) }],
      structuredContent: { error: failure },
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
