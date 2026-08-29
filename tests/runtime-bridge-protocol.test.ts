import { describe, expect, test } from "bun:test"
import {
  decodeRuntimeBridgeClientMessage,
  decodeRuntimeBridgeResponse,
  encodeRuntimeBridgeRequest,
  encodeRuntimeBridgeServerMessage,
  retiredRuntimeSocketPathsFor,
  runtimeBridgeError,
  runtimeBridgeResponse,
  runtimeSocketPathFor,
} from "../src/runtime-bridge-protocol.ts"
import { errorReply, successReply } from "../src/control-protocol.ts"

describe("Runtime bridge requests", () => {
  test("round-trips a typed correlated request and defaults params", () => {
    const encoded = encodeRuntimeBridgeRequest({ id: "r1", method: "work.snapshot", params: { target: "current" } })
    expect(decodeRuntimeBridgeClientMessage(encoded.trim())).toEqual({
      request: { id: "r1", method: "work.snapshot", params: { target: "current" } },
    })
    expect(decodeRuntimeBridgeClientMessage('{"schema_version":1,"type":"request","id":"r2","method":"orient"}'))
      .toEqual({ request: { id: "r2", method: "orient", params: {} } })
  })

  test("separates protocol errors from correlated method and parameter errors", () => {
    expect(decodeRuntimeBridgeClientMessage("nope")).toEqual({
      error: { code: "invalid_request", message: "expected one JSON object per line" },
    })
    expect(decodeRuntimeBridgeClientMessage('{"schema_version":2,"type":"request"}')).toMatchObject({
      error: { code: "unsupported_schema_version" },
    })
    expect(decodeRuntimeBridgeClientMessage('{"schema_version":1,"type":"subscribe"}')).toMatchObject({
      error: { code: "invalid_request" },
    })

    const unknown = decodeRuntimeBridgeClientMessage(
      '{"schema_version":1,"type":"request","id":"9","method":"agent.kill"}',
    )
    if (!("reply" in unknown) || unknown.reply.ok) throw new Error("expected a method error")
    expect(unknown.reply).toMatchObject({ id: "9", error: { code: "unknown_method" } })
    expect(unknown.reply.error.data).toMatchObject({ methods: expect.arrayContaining(["agent.create", "work.steer"]) })

    const params = decodeRuntimeBridgeClientMessage(
      '{"schema_version":1,"type":"request","id":"10","method":"orient","params":[]}',
    )
    expect(params).toEqual({ reply: errorReply("10", { code: "invalid_params", message: "params must be an object" }) })
  })
})

describe("Runtime bridge responses", () => {
  test("round-trips successful and failed control replies", () => {
    const success = encodeRuntimeBridgeServerMessage(runtimeBridgeResponse(successReply("r1", { agent: 1 })))
    expect(decodeRuntimeBridgeResponse(success.trim())).toEqual(successReply("r1", { agent: 1 }))

    const failure = encodeRuntimeBridgeServerMessage(runtimeBridgeResponse(errorReply("r2", {
      code: "busy",
      message: "queue editor visible",
      data: { fx_code: "queue_editor_visible" },
    })))
    expect(decodeRuntimeBridgeResponse(failure.trim())).toEqual(errorReply("r2", {
      code: "busy",
      message: "queue editor visible",
      data: { fx_code: "queue_editor_visible" },
    }))
  })

  test("translates protocol errors and malformed responses", () => {
    expect(decodeRuntimeBridgeResponse(encodeRuntimeBridgeServerMessage(runtimeBridgeError({
      code: "invalid_request",
      message: "bad bridge request",
    })).trim())).toEqual(errorReply(null, { code: "invalid_request", message: "bad bridge request" }))
    expect(decodeRuntimeBridgeResponse("not json")).toMatchObject({ ok: false, error: { code: "invalid_request" } })
    expect(decodeRuntimeBridgeResponse('{"schema_version":1,"type":"response","ok":true,"result":{}}'))
      .toEqual(errorReply(null, { code: "invalid_request", message: "fmx answered without a correlation id" }))
  })
})

test("derives one stable bridge path and identifies retired socket residue", () => {
  for (const source of [
    "/tmp/fmx/u.ade.sock",
    "/tmp/fmx/u.sock",
    "/tmp/fmx/u.ctl",
    "/tmp/fmx/u.obs",
    "/tmp/fmx/u.bus",
  ]) {
    expect(runtimeSocketPathFor(source)).toBe("/tmp/fmx/u.bus")
  }
  expect(retiredRuntimeSocketPathsFor("/tmp/fmx/u.bus")).toEqual(["/tmp/fmx/u.ctl", "/tmp/fmx/u.obs"])
})
