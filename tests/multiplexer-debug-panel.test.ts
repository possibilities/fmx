import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { AgentSocket } from "../src/agent-socket.ts"
import { debugPanelRequested, debugPanelWidth } from "../src/debug-panel.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { instanceOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

async function createMultiplexer(width: number, height: number, debugPanel: boolean) {
  const setup = await createTestRenderer({ width, height })
  const agentSocket = new AgentSocket({ path: `/tmp/fmx-panel-test-${process.pid}.sock` })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...instanceOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    agentSocket,
    debugPanel,
  })
  multiplexer.start()
  setup.mockInput.pressKey("b", { ctrl: true })
  setup.mockInput.pressKey("c")
  const find = (id: string) => setup.renderer.root.findDescendantById(id) as BoxRenderable | undefined
  return { setup, multiplexer, agentSocket, find }
}


async function sendFrame(agentSocket: AgentSocket, payload: string): Promise<void> {
  const connection = await Bun.connect({
    unix: agentSocket.path,
    socket: {
      open: (socket) => {
        socket.write(`${payload}\n`)
      },
      data: () => {},
    },
  })
  // The listener runs synchronously inside the socket's data callback; one
  // turn of the event loop is enough for it to have landed.
  await Bun.sleep(20)
  connection.end()
}

const WORKING_REPORT =
  '{"id":"1","method":"pane.report_agent","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","state":"working"}}'

test("the panel is absent unless its environment variable is present", () => {
  expect(debugPanelRequested({})).toBe(false)
  expect(debugPanelRequested({ FMX_DEBUG_PANEL: "" })).toBe(true)
  expect(debugPanelRequested({ FMX_DEBUG_PANEL: "1" })).toBe(true)
})

test("claims the right third of the screen when enabled", async () => {
  const { setup, multiplexer, find } = await createMultiplexer(90, 24, true)
  try {
    await setup.renderOnce()
    const panel = find("fmx-debug-panel")!
    const divider = find("fmx-debug-divider")!
    const content = find("fmx-content")!

    expect(panel.width).toBe(30)
    expect(panel.height).toBe(24)
    expect(divider.width).toBe(1)
    // sidebar | divider | content | divider | panel
    expect(divider.x).toBe(panel.x - 1)
    expect(content.x + content.width).toBe(divider.x)
    expect(panel.x + panel.width).toBe(90)
  } finally {
    await multiplexer.shutdown()
  }
})

test("leaves the layout untouched when disabled", async () => {
  const { setup, multiplexer, find } = await createMultiplexer(90, 24, false)
  try {
    await setup.renderOnce()
    expect(find("fmx-debug-panel")).toBeUndefined()
    expect(find("fmx-debug-divider")).toBeUndefined()
    const content = find("fmx-content")!
    expect([content.x, content.width]).toEqual([27, 63])
  } finally {
    await multiplexer.shutdown()
  }
})

test("measures the sidebar's third against what the panel leaves behind", async () => {
  const { setup, multiplexer, find } = await createMultiplexer(90, 24, true)
  try {
    await setup.renderOnce()
    const sidebar = find("fmx-sidebar")!
    // 90 - (30 panel + 1 divider) = 59 available; a third of that is 19.
    await setup.mockMouse.drag(26, 10, 40, 10)
    await setup.renderOnce()
    expect(sidebar.width).toBe(19)
  } finally {
    await multiplexer.shutdown()
  }
})

test("appends a scrollable entry per frame crossing the socket", async () => {
  const { setup, multiplexer, agentSocket, find } = await createMultiplexer(90, 24, true)
  try {
    await agentSocket.start()
    await sendFrame(agentSocket, WORKING_REPORT)

    await setup.renderOnce()
    expect(find("fmx-debug-panel-scroll")).toBeDefined()
    // The panel is narrow, so entries wrap mid-token; compare without the
    // whitespace and divider glyphs the surrounding layout introduces.
    const rendered = setup.captureCharFrame().replace(/[\s│]+/gu, "")
    expect(rendered).toContain("p_1pane.report_agent")
    // Re-indented, so the payload reads as nested JSON rather than one line.
    expect(rendered).toContain('"state":"working"')
    // fmx's replies are not shown; only what fx sent.
    expect(rendered).not.toContain('"result":{}')
  } finally {
    agentSocket.close()
    await multiplexer.shutdown()
  }
})

test("sizes the panel to a third at any width", () => {
  expect(debugPanelWidth(90)).toBe(30)
  expect(debugPanelWidth(120)).toBe(40)
  // A narrow screen gets a cramped third, not a reserved minimum that would
  // eat into the embedded terminal.
  expect(debugPanelWidth(40)).toBe(13)
  expect(debugPanelWidth(1)).toBe(1)
})

test("clicking clear empties the tail without stopping the socket", async () => {
  const { setup, multiplexer, agentSocket, find } = await createMultiplexer(90, 24, true)
  try {
    await agentSocket.start()
    await sendFrame(agentSocket, WORKING_REPORT)
    await setup.renderOnce()

    const strip = () => setup.captureCharFrame().replace(/[\s│]+/gu, "")
    expect(strip()).toContain("pane.report_agent")

    const button = find("fmx-debug-panel-clear")!
    expect(button.width).toBe("[clear]".length)
    await setup.mockMouse.click(button.x, button.y)
    await setup.renderOnce()

    const cleared = strip()
    expect(cleared).not.toContain("pane.report_agent")
    // The heading and the button survive; only the entries go.
    expect(cleared).toContain("[clear]")
    expect(cleared).toContain("agentsocket·")

    // The socket is still live, so the next frame lands in the empty panel.
    await sendFrame(agentSocket, WORKING_REPORT)
    await setup.renderOnce()
    expect(strip()).toContain("pane.report_agent")
  } finally {
    agentSocket.close()
    await multiplexer.shutdown()
  }
})
