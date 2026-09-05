import { createTestRenderer } from "@opentui/core/testing"
import { PaneTerminalRenderable } from "../../src/pane-terminal.ts"

const setup = await createTestRenderer({ width: 120, height: 128 })
const terminal = new PaneTerminalRenderable(setup.renderer, {
  id: "page-capacity",
  cols: 120,
  rows: 128,
  position: "absolute",
  visible: true,
  maxScrollback: 10_000_000,
})

try {
  setup.renderer.root.add(terminal)
  let output = ""
  for (let index = 0; index < 512; index += 1) {
    output += `\x1b[38;2;${index % 256};${Math.floor(index / 2) % 256};${Math.floor(index / 3) % 256}m${String.fromCodePoint(65 + (index % 26))}`
  }
  terminal.write(new TextEncoder().encode(`${output}\x1b[0m`))
  await setup.renderOnce()
} finally {
  terminal.destroy()
  setup.renderer.destroy()
}
