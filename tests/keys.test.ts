import { describe, expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import {
  actionForKey,
  DEFAULT_KEYS_CONFIG,
  displayBindings,
  displayIndexedBindings,
  displayKeyCombo,
  keyMatchesCombo,
  parseKeyCombo,
  resolveKeybindings,
} from "../src/keybindings.ts"
import { keyIdentity } from "../src/keys.ts"

const key = (overrides: Partial<KeyEvent> = {}): KeyEvent =>
  ({
    name: "r",
    sequence: "r",
    raw: "r",
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    ...overrides,
  }) as KeyEvent

describe("Herdr-compatible keybindings", () => {
  test("uses Herdr's exact defaults for the supported action subset", () => {
    expect(DEFAULT_KEYS_CONFIG).toEqual({
      prefix: "ctrl+b",
      help: "prefix+?",
      detach: "prefix+q",
      new_tab: "prefix+c",
      previous_tab: "prefix+p",
      next_tab: "prefix+n",
      switch_tab: "prefix+1..9",
      close_tab: "prefix+shift+x",
    })

    const { keybindings, diagnostics } = resolveKeybindings()
    expect(diagnostics).toEqual([])
    expect(displayKeyCombo(keybindings.prefix)).toBe("Ctrl-B")
    expect(displayBindings(keybindings.new_tab, keybindings.prefix)).toBe("Ctrl-B c")
    expect(displayIndexedBindings(keybindings.switch_tab, keybindings.prefix)).toBe("Ctrl-B 1…9")
  })

  test("supports a Ctrl-Space prefix without changing action bindings", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ prefix: "ctrl+space" })
    expect(diagnostics).toEqual([])
    expect(keyMatchesCombo(key({ name: "space", sequence: "\0", raw: "\0", ctrl: true }), keybindings.prefix)).toBe(
      true,
    )
    expect(actionForKey(keybindings, key({ name: "c" }), "prefix")).toEqual({ name: "new_tab" })
    expect(displayBindings(keybindings.help, keybindings.prefix)).toBe("Ctrl-Space ?")
  })

  test("supports Herdr string arrays, direct chords, and indexed ranges", () => {
    const { keybindings, diagnostics } = resolveKeybindings({
      previous_tab: ["prefix+p", "alt+1"],
      next_tab: ["prefix+n", "alt+2"],
      switch_tab: "ctrl+1..9",
    })
    expect(diagnostics).toEqual([])
    expect(actionForKey(keybindings, key({ name: "1", sequence: "\u001b1", raw: "\u001b1", meta: true }), "direct")).toEqual({
      name: "previous_tab",
    })
    expect(actionForKey(keybindings, key({ name: "2", ctrl: true }), "direct")).toEqual({
      name: "switch_tab",
      index: 1,
    })
  })

  test("lets user bindings displace conflicting defaults like Herdr", () => {
    const { keybindings, diagnostics } = resolveKeybindings({ help: "prefix+c" })
    expect(diagnostics).toEqual([])
    expect(actionForKey(keybindings, key({ name: "c" }), "prefix")).toEqual({ name: "help" })
    expect(keybindings.new_tab).toEqual([])
  })

  test("rejects unsafe direct typing bindings", () => {
    const printable = resolveKeybindings({ new_tab: "c" })
    expect(printable.keybindings.new_tab).toEqual([])
    expect(printable.diagnostics.join("\n")).toContain("unsafe direct keybinding")

    const space = resolveKeybindings({ new_tab: "space" })
    expect(space.keybindings.new_tab).toEqual([])
    expect(space.diagnostics.join("\n")).toContain("unsafe direct keybinding")
  })

  test("matches shifted punctuation and Herdr's Shift-X close binding", () => {
    const { keybindings } = resolveKeybindings()
    expect(actionForKey(keybindings, key({ name: "/", sequence: "/", raw: "\u001b[47;2u", shift: true }), "prefix")).toEqual({
      name: "help",
    })
    expect(actionForKey(keybindings, key({ name: "x", sequence: "X", raw: "X", shift: true }), "prefix")).toEqual({
      name: "close_tab",
    })
    expect(actionForKey(keybindings, key({ name: "x" }), "prefix")).toBeNull()

    const shiftedTabs = resolveKeybindings({ switch_tab: "prefix+shift+1..9" }).keybindings
    expect(actionForKey(shiftedTabs, key({ name: "@", sequence: "@", raw: "@" }), "prefix")).toEqual({
      name: "switch_tab",
      index: 1,
    })
  })

  test("parses Herdr modifier and named-key aliases", () => {
    expect(parseKeyCombo("control+option+return")).toMatchObject({ ctrl: true, alt: true, key: "enter" })
    expect(parseKeyCombo("cmd+shift+f12")).toMatchObject({ super: true, shift: true, key: "f12" })
    expect(parseKeyCombo("shift+tab")).toMatchObject({ shift: false, key: "backtab" })
  })
})

test("release identity survives modifier changes for the same physical key", () => {
  expect(keyIdentity({ name: "r", code: "KeyR" })).toBe(keyIdentity({ name: "r", code: "KeyR" }))
  expect(keyIdentity({ name: "r", code: "KeyR" })).not.toBe(keyIdentity({ name: "b", code: "KeyB" }))
})
