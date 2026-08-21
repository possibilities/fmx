import { expect, test } from "bun:test"
import { createFxEnvironment } from "../src/fx-environment.ts"

test("fx child environment describes the embedded terminal, not the outer multiplexer", () => {
  const env = createFxEnvironment(
    {
      PATH: "/bin",
      TERM: "screen-256color",
      TERM_PROGRAM: "tmux",
      TERM_PROGRAM_VERSION: "3.5",
      TMUX: "/tmp/tmux,1,0",
      TMUX_PANE: "%4",
      STY: "screen-session",
      WINDOW: "2",
      ZELLIJ: "1",
      ZELLIJ_PANE_ID: "7",
    },
    12,
    "/work/project",
  )

  expect(env).toMatchObject({
    PATH: "/bin",
    PWD: "/work/project",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "fmx",
    FMX_INSTANCE_ID: "12",
  })
  expect(env.TMUX).toBeUndefined()
  expect(env.TMUX_PANE).toBeUndefined()
  expect(env.STY).toBeUndefined()
  expect(env.WINDOW).toBeUndefined()
  expect(env.ZELLIJ).toBeUndefined()
  expect(env.TERM_PROGRAM_VERSION).toBeUndefined()
})

test("unrelated WINDOW variables survive outside GNU screen", () => {
  expect(createFxEnvironment({ WINDOW: "editor" }, 1, "/work").WINDOW).toBe("editor")
})
