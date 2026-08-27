import { expect, test } from "bun:test"
import { buildKittyKeyboardFlags, CliRenderEvents, type Selection } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { FX_KEYBOARD_PROTOCOL, FxTerminalRenderable } from "../src/fx-terminal.ts"

test("matches fx's host Kitty keyboard protocol", () => {
  expect(buildKittyKeyboardFlags(FX_KEYBOARD_PROTOCOL)).toBe(1)
})

test("gives embedded fx the resolved OSC 11 background without remapping its palette", async () => {
  const setup = await createTestRenderer({ width: 20, height: 6 })
  const responses: string[] = []

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data, source) => {
        if (source === "response") responses.push(new TextDecoder().decode(data))
      },
    })
    setup.renderer.root.add(terminal)

    expect(
      terminal.applyHostTheme({
        theme: "dark",
        background: "#123456",
        source: "osc11",
        explicit: false,
      }),
    ).toBeUndefined()

    terminal.write("\x1b]4;0;?\x1b\\\x1b]10;?;?;?\x1b\\")

    expect(responses.join("")).toContain("\x1b]11;rgb:1212/3434/5656\x1b\\")
  } finally {
    setup.renderer.destroy()
  }
})

test("forwards host key bytes without re-encoding them", async () => {
  const setup = await createTestRenderer({
    width: 20,
    height: 6,
    exitOnCtrlC: false,
    useKittyKeyboard: FX_KEYBOARD_PROTOCOL,
  })
  const sent: Uint8Array[] = []

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data, source) => {
        if (source === "input") sent.push(data)
      },
    })
    setup.renderer.root.add(terminal)
    terminal.focus()

    for (const key of [
      {
        name: "c",
        ctrl: true,
        meta: false,
        shift: false,
        option: false,
        sequence: "c",
        raw: "\u001b[99;5u",
        number: false,
        eventType: "press" as const,
        source: "kitty" as const,
        baseCode: 99,
      },
      {
        name: "u",
        ctrl: true,
        meta: false,
        shift: false,
        option: false,
        sequence: "\u0015",
        raw: "\u0015",
        number: false,
        eventType: "press" as const,
        source: "raw" as const,
      },
      {
        name: "backspace",
        ctrl: false,
        meta: true,
        shift: false,
        option: false,
        sequence: "\u001b\u007f",
        raw: "\u001b\u007f",
        number: false,
        eventType: "press" as const,
        source: "raw" as const,
      },
      {
        name: "backspace",
        ctrl: false,
        meta: true,
        shift: false,
        option: true,
        super: false,
        sequence: "\u001b[127;3u",
        raw: "\u001b[127;3u",
        code: "[127u",
        number: false,
        eventType: "press" as const,
        source: "kitty" as const,
      },
      {
        name: "backspace",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        super: true,
        sequence: "\u001b[127;9u",
        raw: "\u001b[127;9u",
        code: "[127u",
        number: false,
        eventType: "press" as const,
        source: "kitty" as const,
      },
    ]) {
      setup.renderer.keyInput.processParsedKey(key)
    }

    expect(sent.map((data) => new TextDecoder().decode(data))).toEqual([
      "\u001b[99;5u",
      "\u0015",
      "\u001b\u007f",
      "\u001b[127;3u",
      "\u001b[127;9u",
    ])
  } finally {
    setup.renderer.destroy()
  }
})

test("conceals the fresh origin cursor until fx places it", async () => {
  const setup = await createTestRenderer({ width: 20, height: 6 })
  const cursorUpdates: { x: number; y: number; visible: boolean | undefined }[] = []

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: () => {},
    })
    setup.renderer.root.add(terminal)
    const setCursorPosition = setup.renderer.setCursorPosition.bind(setup.renderer)
    setup.renderer.setCursorPosition = (x, y, visible) => {
      cursorUpdates.push({ x, y, visible })
      setCursorPosition(x, y, visible)
    }
    terminal.focus()
    terminal.applyHostTheme({
      theme: "dark",
      background: "#123456",
      source: "osc11",
      explicit: false,
    })
    await setup.renderOnce()

    expect(cursorUpdates.length).toBeGreaterThan(0)
    expect(cursorUpdates.at(-1)?.visible).toBe(false)

    // Queries and metadata are real PTY output but do not establish where fx's
    // input cursor belongs. The emulator's provisional origin stays hidden.
    terminal.write("\u001b[6n\u001b]2;fx starting\u0007")
    await setup.renderOnce()

    expect(cursorUpdates.at(-1)?.visible).toBe(false)

    terminal.write("fx frame\u001b[4;3H")
    await setup.renderOnce()

    expect(cursorUpdates.at(-1)).toEqual({ x: 3, y: 4, visible: true })

    // Once fx has placed a visible cursor, the emulator remains authoritative,
    // including when fx later puts it at the origin deliberately.
    terminal.write("\u001b[H")
    await setup.renderOnce()

    expect(cursorUpdates.at(-1)).toEqual({ x: 1, y: 1, visible: true })
  } finally {
    setup.renderer.destroy()
  }
})

test("keeps one-cell mouse gestures provisional and hidden", async () => {
  const setup = await createTestRenderer({ width: 20, height: 6 })
  const finishedSelections: Selection[] = []

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: () => {},
    })
    setup.renderer.root.add(terminal)
    setup.renderer.on(CliRenderEvents.SELECTION, (selection) => finishedSelections.push(selection))
    terminal.write("select this text\r\n")
    await setup.renderOnce()

    await setup.mockMouse.pressDown(2, 0)
    expect(terminal.hasSelection()).toBe(false)
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("")

    await setup.mockMouse.moveTo(2, 0)
    expect(terminal.hasSelection()).toBe(false)
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("")

    await setup.mockMouse.release(2, 0)
    expect(finishedSelections).toHaveLength(1)
    expect(finishedSelections[0]?.isStart).toBe(true)
    expect(finishedSelections[0]?.getSelectedText()).toBe("")
  } finally {
    setup.renderer.destroy()
  }
})

test("allows an activated selection to contract back to one cell", async () => {
  const setup = await createTestRenderer({ width: 20, height: 6 })
  const finishedSelections: Selection[] = []

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: () => {},
    })
    setup.renderer.root.add(terminal)
    setup.renderer.on(CliRenderEvents.SELECTION, (selection) => finishedSelections.push(selection))
    terminal.write("select this text\r\n")
    await setup.renderOnce()

    await setup.mockMouse.pressDown(0, 0)
    await setup.mockMouse.moveTo(1, 0)
    expect(terminal.hasSelection()).toBe(true)
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("se")

    await setup.mockMouse.moveTo(0, 0)
    expect(terminal.hasSelection()).toBe(true)
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("s")

    await setup.mockMouse.release(0, 0)
    expect(finishedSelections).toHaveLength(1)
    expect(finishedSelections[0]?.isStart).toBe(false)
    expect(finishedSelections[0]?.getSelectedText()).toBe("s")
  } finally {
    setup.renderer.destroy()
  }
})

test("ordinary drags select embedded text when fx has not requested mouse input", async () => {
  const setup = await createTestRenderer({ width: 20, height: 6 })
  const sent: string[] = []

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data, source) => {
        if (source === "input") sent.push(new TextDecoder().decode(data))
      },
    })
    setup.renderer.root.add(terminal)
    terminal.write("select this text\r\n")
    await setup.renderOnce()

    await setup.mockMouse.drag(0, 0, 5, 0)

    expect(terminal.selectable).toBe(true)
    expect(terminal.hasSelection()).toBe(true)
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("select")
    expect(sent).toEqual([])
  } finally {
    setup.renderer.destroy()
  }
})

test("fx mouse reporting cancels OpenTUI's provisional selection", async () => {
  const setup = await createTestRenderer({ width: 20, height: 6 })
  const sent: string[] = []
  const decoder = new TextDecoder()

  try {
    const terminal = new FxTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data, source) => {
        if (source === "input") sent.push(decoder.decode(data))
      },
    })
    setup.renderer.root.add(terminal)
    terminal.write("fx owns this screen\r\n\u001b[?1002h\u001b[?1006h")
    await setup.renderOnce()

    await setup.mockMouse.drag(1, 1, 8, 1)

    expect(terminal.selectable).toBe(true)
    expect(terminal.hasSelection()).toBe(false)
    expect(setup.renderer.hasSelection).toBe(false)
    expect(sent.join("")).toMatch(/\u001b\[<\d+;\d+;\d+[Mm]/u)
  } finally {
    setup.renderer.destroy()
  }
})
