import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { ControlMethod } from "../src/control-protocol.ts"
import { createFmxMcpServer } from "../src/mcp-server.ts"
import { RuntimeRequestError, type RuntimeRequester } from "../src/runtime-client.ts"

const agent = {
  agent_id: "0123456789abcdef0123456789abcdef",
  id: 1,
  display_id: 1,
  pane_id: "p_0123456789abcdef0123456789abcdef",
  created_at: 1_772_000_000_000,
  cwd: "/workspace/fmx",
  project: "fmx",
  git_root: "/workspace/fmx",
  main_git_root: "/workspace/fmx",
  branch: "main",
  worktree: false,
  name: "build-mcp",
  session_id: "1772000000000-1772000000000000000-session",
  label: "build-mcp",
  state: "working" as const,
  attention: null,
  active: true,
  subagents: [],
}

const orientation = {
  fmx: { pid: 123, version: "0.3.0", cwd: "/workspace/fmx", cols: 100, rows: 30 },
  you: agent,
  active: 1,
  agents: [agent],
  tray: {
    visible: true,
    hidden: false,
    width: 26,
    rows: [
      { kind: "project" as const, depth: 0, text: "fmx", agent: null, active: true },
      { kind: "agent" as const, depth: 1, text: "· build-mcp", agent: 1, active: true },
    ],
  },
  surface: { kind: "none" as const },
}

const work = {
  active_turn_id: "41",
  queue_paused: false,
  queue: [{
    turn_id: "42",
    kind: "steering" as const,
    text: "tighten the tests",
    has_images: false,
    has_skill_bindings: false,
    has_review_draft: false,
  }],
}

const agentWork = { agent, work }
const admittedWork = { ...agentWork, turn_id: "42", disposition: "steering" as const }

type Call = { method: ControlMethod; params: Record<string, unknown>; signal: AbortSignal }

class FakeRequester implements RuntimeRequester {
  readonly calls: Call[] = []

  async request(
    method: ControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ method, params, signal })
    switch (method) {
      case "orient": return orientation
      case "agent.create": return { agent }
      case "focus": return { agent }
      case "tray": return { visible: true, hidden: false, width: 31 }
      case "work.queue":
      case "work.steer": return admittedWork
      case "work.snapshot":
      case "work.interrupt":
      case "queue.update":
      case "queue.delete":
      case "queue.resume": return agentWork
    }
  }
}

test("publishes the complete approved MCP surface and returns structured results", async () => {
  const requester = new FakeRequester()
  const server = createFmxMcpServer(requester)
  const client = new Client({ name: "fmx-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "get_orientation",
      "create_agent",
      "focus_agent",
      "configure_tray",
      "get_agent_work",
      "queue_agent_work",
      "steer_agent",
      "interrupt_agent",
      "update_queued_work",
      "delete_queued_work",
      "resume_agent_queue",
    ])
    const oriented = await client.callTool({ name: "get_orientation", arguments: {} })
    expect(oriented.structuredContent).toEqual(orientation)
    const created = await client.callTool({
      name: "create_agent",
      arguments: { directory: "/workspace/fmx", worktree: true, model: "gpt-5", effort: "high" },
    })
    expect(created.structuredContent).toEqual({ agent })
    const focused = await client.callTool({ name: "focus_agent", arguments: { target: agent.agent_id } })
    expect(focused.structuredContent).toEqual({ agent })
    const tray = await client.callTool({
      name: "configure_tray",
      arguments: { width: 31, hidden: false },
    })
    expect(tray.structuredContent).toEqual({ visible: true, hidden: false, width: 31 })

    expect((await client.callTool({
      name: "get_agent_work",
      arguments: { target: agent.agent_id },
    })).structuredContent).toEqual(agentWork)
    expect((await client.callTool({
      name: "queue_agent_work",
      arguments: { target: "1", text: "do this next" },
    })).structuredContent).toEqual(admittedWork)
    expect((await client.callTool({
      name: "steer_agent",
      arguments: { text: "adjust the active turn" },
    })).structuredContent).toEqual(admittedWork)
    expect((await client.callTool({
      name: "interrupt_agent",
      arguments: { target: "active" },
    })).structuredContent).toEqual(agentWork)
    expect((await client.callTool({
      name: "update_queued_work",
      arguments: { target: agent.agent_id, turn_id: "42", text: "replacement" },
    })).structuredContent).toEqual(agentWork)
    expect((await client.callTool({
      name: "delete_queued_work",
      arguments: { turn_id: "42" },
    })).structuredContent).toEqual(agentWork)
    expect((await client.callTool({
      name: "resume_agent_queue",
      arguments: {},
    })).structuredContent).toEqual(agentWork)

    expect(requester.calls.map(({ method, params }) => [method, params])).toEqual([
      ["orient", {}],
      ["agent.create", { directory: "/workspace/fmx", worktree: true, model: "gpt-5", effort: "high" }],
      ["focus", { target: agent.agent_id }],
      ["tray", { width: 31, hidden: false }],
      ["work.snapshot", { target: agent.agent_id }],
      ["work.queue", { target: "1", text: "do this next" }],
      ["work.steer", { text: "adjust the active turn" }],
      ["work.interrupt", { target: "active" }],
      ["queue.update", { target: agent.agent_id, turn_id: "42", text: "replacement" }],
      ["queue.delete", { turn_id: "42" }],
      ["queue.resume", {}],
    ])
  } finally {
    await client.close()
    await server.close()
  }
})

test("rejects contradictory Tray visibility inputs before reaching the Runtime", async () => {
  const requester = new FakeRequester()
  const server = createFmxMcpServer(requester)
  const client = new Client({ name: "fmx-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    const result = await client.callTool({
      name: "configure_tray",
      arguments: { hidden: true, toggle: true },
    })
    expect(result.isError).toBe(true)
    expect(requester.calls).toEqual([])
  } finally {
    await client.close()
    await server.close()
  }
})

test("returns Runtime failures as machine-readable structured errors", async () => {
  const requester: RuntimeRequester = {
    request: async () => {
      throw new RuntimeRequestError({
        code: "busy",
        message: "the human queue editor is visible",
        data: { fx_code: "queue_editor_visible" },
      })
    },
  }
  const server = createFmxMcpServer(requester)
  const client = new Client({ name: "fmx-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    await client.listTools()
    const result = await client.callTool({ name: "get_agent_work", arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error: {
        code: "busy",
        message: "the human queue editor is visible",
        data: { fx_code: "queue_editor_visible" },
      },
    })
  } finally {
    await client.close()
    await server.close()
  }
})
