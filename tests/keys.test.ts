import { describe, expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import {
  actionForKey,
  keyIdentity,
  keyMatchesCombo,
  parseKeyCombo,
  resolveKeybindings,
} from "../src/keybindings.ts"

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

describe("keybindings", () => {
  test("provides default bindings for every supported action", () => {
    const { keybindings, diagnostics } = resolveKeybindings()
    expect(diagnostics).toEqual([])
    expect(keybindings.prefixLabel).toBe("ctrl+b")
    expect(keybindings.detach.map((binding) => binding.label)).toEqual(["prefix+d"])
    expect(keybindings.toggle_tray.map((binding) => binding.label)).toEqual(["prefix+b"])
    expect(actionForKey(keybindings, key({ name: "d" }), "prefix")).toEqual({ name: "detach" })
    expect(actionForKey(keybindings, key({ name: "b" }), "prefix")).toEqual({ name: "toggle_tray" })
  })

  test("reports the retired launch binding as unknown", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ launch: "prefix+o" })
    expect(diagnostics).toEqual(["unknown config key keys.launch; ignoring key"])
    expect(actionForKey(keybindings, key({ name: "o" }), "prefix")).toBeNull()
  })

  test("supports a Ctrl-Space prefix without changing action bindings", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ prefix: "ctrl+space" })
    expect(diagnostics).toEqual([])
    expect(keyMatchesCombo(key({ name: "space", sequence: "\0", raw: "\0", ctrl: true }), keybindings.prefix)).toBe(
      true,
    )
    expect(keybindings.help.map((binding) => binding.label)).toEqual(["prefix+?"])
  })

  test("supports string arrays and direct chords", () => {
    const { keybindings, diagnostics } = resolveKeybindings({
      previous_tab: ["prefix+p", "alt+1"],
      next_tab: ["prefix+n", "alt+2"],
    })
    expect(diagnostics).toEqual([])
    expect(actionForKey(keybindings, key({ name: "1", sequence: "\u001b1", raw: "\u001b1", meta: true }), "direct")).toEqual({
      name: "previous_tab",
    })
    expect(actionForKey(keybindings, key({ name: "2", sequence: "\u001b2", raw: "\u001b2", meta: true }), "direct")).toEqual({
      name: "next_tab",
    })
  })

  test("lets user bindings displace conflicting defaults", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ help: "prefix+n" })
    expect(diagnostics).toEqual([])
    expect(actionForKey(keybindings, key({ name: "n" }), "prefix")).toEqual({ name: "help" })
    expect(keybindings.next_tab).toEqual([])
  })

  test("rejects unsafe direct typing bindings", () => {
    const printable = resolveKeybindings({ help: "c" })
    expect(printable.keybindings.help).toEqual([])
    expect(printable.diagnostics.join("\n")).toContain("unsafe direct keybinding")

    const space = resolveKeybindings({ help: "space" })
    expect(space.keybindings.help).toEqual([])
    expect(space.diagnostics.join("\n")).toContain("unsafe direct keybinding")
  })

  test("reports a retired keys.new_tab as an unknown key", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ new_tab: "prefix+c" })
    expect(diagnostics).toEqual(["unknown config key keys.new_tab; ignoring key"])
    expect(actionForKey(keybindings, key({ name: "c" }), "prefix")).toBeNull()
  })

  test("matches shifted punctuation without reserving Shift-X", () => {
    const { keybindings } = resolveKeybindings()
    expect(actionForKey(keybindings, key({ name: "/", sequence: "/", raw: "\u001b[47;2u", shift: true }), "prefix")).toEqual({
      name: "help",
    })
    expect(actionForKey(keybindings, key({ name: "x", sequence: "X", raw: "X", shift: true }), "prefix")).toBeNull()
    expect(actionForKey(keybindings, key({ name: "x" }), "prefix")).toBeNull()
  })

  test("parses modifier and named-key aliases", () => {
    expect(parseKeyCombo("control+option+return")).toMatchObject({ ctrl: true, alt: true, key: "enter" })
    expect(parseKeyCombo("cmd+shift+f12")).toMatchObject({ super: true, shift: true, key: "f12" })
    expect(parseKeyCombo("shift+tab")).toMatchObject({ shift: false, key: "backtab" })
  })
})

test("release identity survives modifier changes for the same physical key", () => {
  expect(keyIdentity({ name: "r", code: "KeyR" })).toBe(keyIdentity({ name: "r", code: "KeyR" }))
  expect(keyIdentity({ name: "r", code: "KeyR" })).not.toBe(keyIdentity({ name: "b", code: "KeyB" }))
})
