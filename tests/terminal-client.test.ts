import { expect, test } from "bun:test"
import { resolveKeybindings } from "../src/keybindings.ts"
import { ClientInputFilter, ClientOutputRelay } from "../src/terminal-client.ts"

test("an empty Runtime Restore leaves the shell surface intact", () => {
  const writes: Uint8Array[] = []
  const relay = new ClientOutputRelay((bytes) => writes.push(bytes))

  relay.beginRestore()
  relay.output(new Uint8Array())
  relay.ready()
  relay.output(new TextEncoder().encode("LIVE"))

  expect(writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(["LIVE"])
})

test("a populated Restore resets and conceals in the same write as its first bytes", () => {
  const writes: Uint8Array[] = []
  const relay = new ClientOutputRelay((bytes) => writes.push(bytes))

  relay.beginRestore()
  relay.output(new TextEncoder().encode("RESTORED"))
  relay.output(new TextEncoder().encode(" LIVE"))
  relay.ready()

  expect(writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
    "\x1bc\x1b[?25lRESTORED",
    " LIVE",
  ])
})

test("prefix Detach is consumed locally and never arms the shared Runtime", () => {
  const forwarded: Uint8Array[] = []
  let detached = 0
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => detached += 1,
  )
  try {
    filter.push(Uint8Array.from([0x02, 0x64])) // ctrl-b d
    expect(detached).toBe(1)
    expect(forwarded).toEqual([])
  } finally {
    filter.destroy()
  }
})

test("a non-Detach prefix command reaches the Runtime as its original bytes", () => {
  const forwarded: Uint8Array[] = []
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => {
      throw new Error("unexpected detach")
    },
  )
  try {
    filter.push(Uint8Array.from([0x02, 0x63])) // ctrl-b c
    expect([...joinBytes(forwarded)]).toEqual([0x02, 0x63])
  } finally {
    filter.destroy()
  }
})

test("a configured direct Detach chord is Client-local too", () => {
  const forwarded: Uint8Array[] = []
  let detached = 0
  const filter = new ClientInputFilter(
    resolveKeybindings({ detach: "ctrl+g" }).keybindings,
    (bytes) => forwarded.push(bytes),
    () => detached += 1,
  )
  try {
    filter.push(Uint8Array.from([0x07]))
    expect(detached).toBe(1)
    expect(forwarded).toEqual([])
  } finally {
    filter.destroy()
  }
})

test("ordinary input and bracketed paste retain their terminal bytes", () => {
  const forwarded: Uint8Array[] = []
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => {
      throw new Error("unexpected detach")
    },
  )
  const input = new TextEncoder().encode("x\x1b[200~hello\nworld\x1b[201~")
  try {
    filter.push(input)
    expect(new TextDecoder().decode(joinBytes(forwarded))).toBe("x\x1b[200~hello\nworld\x1b[201~")
  } finally {
    filter.destroy()
  }
})

test("mouse motion and focus reports retain their terminal bytes", () => {
  const forwarded: Uint8Array[] = []
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => {
      throw new Error("unexpected detach")
    },
  )
  const input = new TextEncoder().encode("\x1b[<35;10;5M\x1b[I\x1b[O")
  try {
    filter.push(input)
    expect(new TextDecoder().decode(joinBytes(forwarded))).toBe("\x1b[<35;10;5M\x1b[I\x1b[O")
  } finally {
    filter.destroy()
  }
})

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
