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

test("an inherited agent socket never reaches fx", () => {
  const env = createFxEnvironment(
    {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/someone-else.sock",
      HERDR_CLIENT_SOCKET_PATH: "/tmp/someone-else-client.sock",
      HERDR_PANE_ID: "w1:p9",
      HERDR_TAB_ID: "t3",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_BIN_PATH: "/usr/local/bin/other",
    },
    3,
    "/work",
  )

  expect(env.HERDR_ENV).toBeUndefined()
  expect(env.HERDR_SOCKET_PATH).toBeUndefined()
  expect(env.HERDR_CLIENT_SOCKET_PATH).toBeUndefined()
  expect(env.HERDR_PANE_ID).toBeUndefined()
  expect(env.HERDR_TAB_ID).toBeUndefined()
  expect(env.HERDR_WORKSPACE_ID).toBeUndefined()
  expect(env.HERDR_BIN_PATH).toBeUndefined()
})

test("fmx's own agent socket replaces whatever was inherited", () => {
  const env = createFxEnvironment(
    { HERDR_SOCKET_PATH: "/tmp/someone-else.sock", HERDR_PANE_ID: "w1:p9" },
    3,
    "/work",
    { socketPath: "/tmp/fmx-42.sock", paneId: "p_3" },
  )

  expect(env.HERDR_SOCKET_PATH).toBe("/tmp/fmx-42.sock")
  expect(env.HERDR_PANE_ID).toBe("p_3")
  expect(env.HERDR_ENV).toBeUndefined()
})

test("hands every instance the control socket, and clears one inherited from another fmx", () => {
  const env = createFxEnvironment({ FMX_SOCKET_PATH: "/tmp/fmx-1.ctl" }, 3, "/work", null, "/tmp/fmx-42.ctl")
  expect(env.FMX_SOCKET_PATH).toBe("/tmp/fmx-42.ctl")
  expect(env.FMX_INSTANCE_ID).toBe("3")
  expect(createFxEnvironment({ FMX_SOCKET_PATH: "/tmp/fmx-1.ctl" }, 3, "/work").FMX_SOCKET_PATH).toBeUndefined()
})

test("applies model and effort to one instance without changing unrelated launches", () => {
  const ambient = { FX_MODEL: "ambient-model", FX_EFFORT: "medium" }
  expect(createFxEnvironment(ambient, 3, "/work")).toMatchObject(ambient)

  const selected = createFxEnvironment(ambient, 4, "/work", null, null, {
    model: "gpt-5.6-luna",
    effort: "max",
  })
  expect(selected.FX_MODEL).toBe("gpt-5.6-luna")
  expect(selected.FX_EFFORT).toBe("max")
})

test("an inherited Companion session is not handed on to fx", () => {
  const env = createFxEnvironment({ ZMX_DIR: "/theirs", ZMX_SESSION: "theirs", ZMX_SESSION_PREFIX: "x" }, 1, "/work")
  expect(env.ZMX_DIR).toBeUndefined()
  expect(env.ZMX_SESSION).toBeUndefined()
  expect(env.ZMX_SESSION_PREFIX).toBeUndefined()
})
