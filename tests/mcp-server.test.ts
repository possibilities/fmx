import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { ControlMethod } from "../src/control-protocol.ts"
import { createFmxMcpServer } from "../src/mcp-server.ts"
import type { RuntimeRequester } from "../src/runtime-client.ts"

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
      case "focus": return { agent }
      case "tray": return { visible: true, hidden: false, width: 31 }
    }
  }
}

test("publishes only the approved phase-one tools and returns structured results", async () => {
  const requester = new FakeRequester()
  const server = createFmxMcpServer(requester)
  const client = new Client({ name: "fmx-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "get_orientation",
      "focus_agent",
      "configure_tray",
    ])
    expect(listed.tools.map((tool) => tool.name)).not.toContain("launch_agent")

    const oriented = await client.callTool({ name: "get_orientation", arguments: {} })
    expect(oriented.structuredContent).toEqual(orientation)
    const focused = await client.callTool({ name: "focus_agent", arguments: { target: agent.agent_id } })
    expect(focused.structuredContent).toEqual({ agent })
    const tray = await client.callTool({
      name: "configure_tray",
      arguments: { width: 31, hidden: false },
    })
    expect(tray.structuredContent).toEqual({ visible: true, hidden: false, width: 31 })
    expect(requester.calls.map(({ method, params }) => [method, params])).toEqual([
      ["orient", {}],
      ["focus", { target: agent.agent_id }],
      ["tray", { width: 31, hidden: false }],
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
