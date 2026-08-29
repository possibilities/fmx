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

const targetDescription =
  "Stable agent_id (preferred), display id, pane_id, current, active, next, previous, exact session name, or unique session-id prefix."

export function createFmxMcpServer(requester: RuntimeRequester = new RuntimeClient()): McpServer {
  const server = new McpServer(
    { name: "fmx", version: VERSION },
    {
      instructions:
        "Inspect and control the running fmx Runtime. Agent creation and Fx work control are intentionally not part of this phase-one surface.",
    },
  )

  server.registerTool(
    "get_orientation",
    {
      title: "Get fmx orientation",
      description:
        "Read the caller, active Agent, every Agent and subagent, Tray tree, terminal dimensions, and open fmx surface.",
      outputSchema: orientationSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (extra) => runTool(() => requester.request("orient", {}, extra.signal)),
  )

  server.registerTool(
    "focus_agent",
    {
      title: "Focus an fmx Agent",
      description: "Select the Agent shown on the shared fmx surface. Refuses while a modal is open.",
      inputSchema: {
        target: z.string().min(1).describe(targetDescription),
      },
      outputSchema: {
        agent: agentSchema,
      },
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
      outputSchema: traySchema,
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
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
