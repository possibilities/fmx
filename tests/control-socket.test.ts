import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { exchange, UnreachableError } from "../src/control-client.ts"
import { ControlFailure, type ControlMethod } from "../src/control-protocol.ts"
import { afterControlReply, ControlSocket, type ControlSurface } from "../src/control-socket.ts"

function socketPath(name: string): string {
  return `/tmp/fmx-ctl-test-${name}-${process.pid}.sock`
}

type Call = { method: ControlMethod; params: Record<string, unknown> }

function surface(answer: (call: Call, signal: AbortSignal) => Promise<unknown>): ControlSurface & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    handle: (method, params, signal) => {
      calls.push({ method, params })
      return answer({ method, params }, signal)
    },
  }
}

test("answers one request per connection and closes it", async () => {
  const fake = surface(async ({ method }) => ({ echoed: method }))
  const socket = new ControlSocket(fake, socketPath("echo"))
  socket.start()
  try {
    const reply = await exchange(socket.path, "orient", { caller: 2 }, 1000)
    expect(reply).toEqual({ id: expect.any(String), ok: true, result: { echoed: "orient" } })
    expect(fake.calls).toEqual([{ method: "orient", params: { caller: 2 } }])
  } finally {
    socket.close()
  }
  expect(existsSync(socket.path)).toBe(false)
})

test("runs an after-reply action only once the successful reply is delivered", async () => {
  let deliveries = 0
  const socket = new ControlSocket(
    surface(async () => afterControlReply({ detached: true }, () => deliveries += 1)),
    socketPath("after-reply"),
  )
  socket.start()
  try {
    const reply = await exchange(socket.path, "detach", {}, 1000)
    expect(reply).toEqual({ id: expect.any(String), ok: true, result: { detached: true } })
    const deadline = Date.now() + 1_000
    while (deliveries === 0 && Date.now() < deadline) await Bun.sleep(1)
    expect(deliveries).toBe(1)
  } finally {
    socket.close()
  }
})

test("is readable by its owner alone", () => {
  const socket = new ControlSocket(surface(async () => null), socketPath("mode"))
  socket.start()
  try {
    expect(statSync(socket.path).mode & 0o777).toBe(0o600)
  } finally {
    socket.close()
  }
})

test("carries a handler's failure back with its code", async () => {
  const socket = new ControlSocket(
    surface(async () => {
      throw new ControlFailure("busy", "something is open", { surface: { kind: "help" } })
    }),
    socketPath("busy"),
  )
  socket.start()
  try {
    const reply = await exchange(socket.path, "focus", { target: "next" }, 1000)
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.error).toEqual({ code: "busy", message: "something is open", data: { surface: { kind: "help" } } })
    }
  } finally {
    socket.close()
  }
})

test("reports an unknown method without consulting the surface", async () => {
  const fake = surface(async () => null)
  const socket = new ControlSocket(fake, socketPath("unknown"))
  socket.start()
  try {
    const reply = await exchange(socket.path, "pane.kill" as ControlMethod, {}, 1000)
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe("unknown_method")
    expect(fake.calls).toEqual([])
  } finally {
    socket.close()
  }
})

test("aborts a waiting handler when the client hangs up", async () => {
  const aborted = Promise.withResolvers<void>()
  const socket = new ControlSocket(
    surface(
      (_call, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => aborted.resolve())
        }),
    ),
    socketPath("abort"),
  )
  socket.start()
  try {
    const reply = await exchange(socket.path, "draft.wait", {}, 50)
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe("timeout")
    await aborted.promise
  } finally {
    socket.close()
  }
})

test("a socket nobody listens on is unreachable, not a failure", async () => {
  await expect(exchange(socketPath("absent"), "orient", {}, 1000)).rejects.toBeInstanceOf(UnreachableError)
})
