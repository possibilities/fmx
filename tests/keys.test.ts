import { describe, expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { keyMatchesCombo, parseKeyCombo, resolveKeybindings } from "../src/keybindings.ts"

const key = (overrides: Partial<KeyEvent> = {}): KeyEvent => {
  const name = overrides.name ?? "r"
  return {
    name,
    sequence: overrides.sequence ?? name,
    raw: overrides.raw ?? name,
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    ...overrides,
  } as KeyEvent
}

const matches = (bindings: ReturnType<typeof resolveKeybindings>["keybindings"], event: KeyEvent, trigger: "direct" | "prefix") =>
  bindings.detach.some((binding) => binding.trigger === trigger && keyMatchesCombo(event, binding.combo))

describe("keybindings", () => {
  test("claims exactly one chord: prefix and Detach", () => {
    const { keybindings, diagnostics } = resolveKeybindings()
    expect(diagnostics).toEqual([])
    expect(keybindings.prefixLabel).toBe("ctrl+b")
    expect(keybindings.detach.map((binding) => binding.label)).toEqual(["prefix+d"])
    expect(Object.keys(keybindings).sort()).toEqual(["detach", "prefix", "prefixLabel"])
    expect(matches(keybindings, key({ name: "d" }), "prefix")).toBe(true)
  })

  test("reports every retired action as an unknown key", () => {
    for (const retired of ["help", "previous_tab", "next_tab", "toggle_tray", "launch", "new_tab"]) {
      const { diagnostics } = resolveKeybindings({ [retired]: "prefix+o" })
      expect(diagnostics).toEqual([`unknown config key keys.${retired}; ignoring key`])
    }
  })

  test("supports a Ctrl-Space prefix", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ prefix: "ctrl+space" })
    expect(diagnostics).toEqual([])
    expect(keyMatchesCombo(key({ name: "space", sequence: "\0", raw: "\0", ctrl: true }), keybindings.prefix)).toBe(true)
    expect(keybindings.detach.map((binding) => binding.label)).toEqual(["prefix+d"])
  })

  test("supports string arrays and direct chords for Detach", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ detach: ["prefix+d", "alt+1"] })
    expect(diagnostics).toEqual([])
    expect(matches(keybindings, key({ name: "d" }), "prefix")).toBe(true)
    expect(matches(keybindings, key({ name: "1", sequence: "1", raw: "1", meta: true }), "direct")).toBe(true)
  })

  test("refuses a Detach binding that would intercept ordinary typing", () => {
    const printable = resolveKeybindings({ detach: "d" })
    expect(printable.keybindings.detach).toEqual([])
    expect(printable.diagnostics.join("\n")).toContain("unsafe direct keybinding")

    const space = resolveKeybindings({ detach: "space" })
    expect(space.keybindings.detach).toEqual([])
    expect(space.diagnostics.join("\n")).toContain("unsafe direct keybinding")
  })

  test("refuses a Detach binding that shadows the prefix-mode key itself", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ detach: "prefix+ctrl+b" })
    expect(keybindings.detach).toEqual([])
    expect(diagnostics.join("\n")).toContain("reserved keybinding")
  })

  test("a prefix chord that only shares the letter is an ordinary binding", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ detach: "prefix+b" })
    expect(diagnostics).toEqual([])
    expect(matches(keybindings, key({ name: "b" }), "prefix")).toBe(true)
  })

  test("parses the binding grammar it shares with its neighbours", () => {
    expect(parseKeyCombo("ctrl+b")).toMatchObject({ ctrl: true, key: "b" })
    expect(parseKeyCombo("shift+tab")).toMatchObject({ shift: false, key: "backtab" })
    expect(parseKeyCombo("f12")).toMatchObject({ key: "f12" })
    expect(parseKeyCombo("nonsense+")).toBeNull()
  })
})
