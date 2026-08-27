import { describe, expect, test } from "bun:test"
import {
  BUS_SCHEMA_VERSION,
  busActivity,
  busError,
  busResponse,
  busSocketPathFor,
  decodeBusClientMessage,
  decodeBusResponse,
  encodeBusRequest,
  encodeBusServerMessage,
  encodeBusSubscription,
  retiredSocketPathsFor,
  summarizeAdePayload,
} from "../src/bus-protocol.ts"
import { errorReply, successReply } from "../src/control-protocol.ts"
import { record } from "./fixtures/ade-feed.ts"

describe("bus client messages", () => {
  test("encodes and decodes a versioned subscription", () => {
    const encoded = encodeBusSubscription({
      schemaVersion: BUS_SCHEMA_VERSION,
      topics: ["state", "activity"],
      activityPayload: "raw",
    })
    expect(encoded.endsWith("\n")).toBe(true)
    expect(JSON.parse(encoded)).toEqual({
      schema_version: 1,
      type: "subscribe",
      topics: ["state", "activity"],
      activity_payload: "raw",
    })
    expect(decodeBusClientMessage(encoded)).toEqual({
      message: {
        type: "subscribe",
        subscription: {
          schemaVersion: 1,
          topics: ["state", "activity"],
          activityPayload: "raw",
        },
      },
    })
  })

  test("defaults subscriptions to state with summarized activity payloads", () => {
    expect(decodeBusClientMessage('{"schema_version":1,"type":"subscribe"}')).toEqual({
      message: {
        type: "subscribe",
        subscription: { schemaVersion: 1, topics: ["state"], activityPayload: "summary" },
      },
    })
  })

  test("round-trips typed control requests and defaults params", () => {
    const encoded = encodeBusRequest({ id: "7", method: "focus", params: { target: "next" } })
    expect(JSON.parse(encoded)).toEqual({
      schema_version: 1,
      type: "request",
      id: "7",
      method: "focus",
      params: { target: "next" },
    })
    expect(decodeBusClientMessage(encoded)).toEqual({
      message: { type: "request", request: { id: "7", method: "focus", params: { target: "next" } } },
    })
    expect(decodeBusClientMessage('{"schema_version":1,"type":"request","id":"8","method":"orient"}')).toEqual({
      message: { type: "request", request: { id: "8", method: "orient", params: {} } },
    })
  })

  test("separates protocol errors from correlated command errors", () => {
    expect(decodeBusClientMessage("nope")).toMatchObject({ error: { code: "invalid_request" } })
    expect(decodeBusClientMessage('{"schema_version":2,"type":"subscribe"}')).toMatchObject({
      error: { code: "unsupported_schema_version" },
    })
    expect(decodeBusClientMessage('{"schema_version":1,"type":"subscribe","topics":[]}')).toMatchObject({
      error: { code: "invalid_request" },
    })
    expect(decodeBusClientMessage('{"schema_version":1,"type":"subscribe","topics":["metrics"]}')).toMatchObject({
      error: { code: "invalid_request" },
    })
    expect(decodeBusClientMessage('{"schema_version":1,"type":"subscribe","activity_payload":"everything"}')).toMatchObject({
      error: { code: "invalid_request" },
    })
    const unknown = decodeBusClientMessage('{"schema_version":1,"type":"request","id":"9","method":"agent.kill"}')
    if (!("reply" in unknown) || unknown.reply.ok) throw new Error("expected a command error")
    expect(unknown.reply).toMatchObject({ id: "9", error: { code: "unknown_method" } })
    expect(unknown.reply.error.data).toEqual({ methods: expect.arrayContaining(["orient", "launch"]) })
  })
})

describe("bus server messages", () => {
  const runtime = { id: "runtime", home_id: "home", pid: 123, version: "0.3.0" }

  test("adds Runtime and state-revision correlation to control responses", () => {
    const success = busResponse(successReply("1", { agent: 3 }), runtime, 7)
    expect(JSON.parse(encodeBusServerMessage(success))).toEqual({
      schema_version: 1,
      type: "response",
      runtime,
      state_revision: 7,
      id: "1",
      ok: true,
      result: { agent: 3 },
    })
    expect(decodeBusResponse(JSON.stringify(success))).toEqual({ id: "1", ok: true, result: { agent: 3 } })

    const failure = busResponse(
      errorReply("2", { code: "busy", message: "something is open", data: { surface: "help" } }),
      runtime,
      8,
    )
    expect(decodeBusResponse(encodeBusServerMessage(failure))).toEqual({
      id: "2",
      ok: false,
      error: { code: "busy", message: "something is open", data: { surface: "help" } },
    })
  })

  test("ignores events and translates protocol errors for a command-only client", () => {
    expect(decodeBusResponse('{"schema_version":1,"type":"event"}')).toBeNull()
    expect(decodeBusResponse(encodeBusServerMessage(busError({ code: "capacity", message: "full" })))).toEqual({
      id: null,
      ok: false,
      error: { code: "invalid_request", message: "full" },
    })
    expect(decodeBusResponse("garbage")).toMatchObject({ ok: false, error: { code: "invalid_request" } })
  })
})

describe("ADE activity projection", () => {
  test("attributes activity without leaking sensitive fields in summary mode", () => {
    const ade = record("PreToolUse", {
      sequence: 9,
      instanceId: "agent-stable-id",
      sessionId: "child-session",
      parentSessionId: "main-session",
      role: "subagent",
      workspaceRoot: "/workspace/fmx",
      subagentId: 7,
      turnId: 42,
      state: "working",
      payload: {
        step_index: 3,
        call_id: "call-3",
        tool_name: "terminal",
        arguments: { command: "printenv SECRET" },
      },
    })

    expect(busActivity(ade, "agent-stable-id", 4, true, "summary")).toEqual({
      name: "PreToolUse",
      ade_sequence: 9,
      gap_before: true,
      agent_id: "agent-stable-id",
      display_id: 4,
      agent_role: "subagent",
      workspace_root: "/workspace/fmx",
      session_id: "child-session",
      parent_session_id: "main-session",
      subagent_id: 7,
      turn_id: 42,
      agent_state: "working",
      attention_kind: null,
      payload_mode: "summary",
      payload: { step_index: 3, call_id: "call-3", tool_name: "terminal" },
    })
  })

  test("raw mode is explicit, and summaries never pass nested values through", () => {
    const ade = record("Stop", {
      payload: {
        step_index: 5,
        assistant_text: "a secret answer",
        provider_disposition: "completed",
        can_continue: true,
        nested: { secret: true },
      },
    })
    expect(summarizeAdePayload(ade)).toEqual({
      step_index: 5,
      provider_disposition: "completed",
      can_continue: true,
    })
    expect(busActivity(ade, ade.instanceId, 1, false, "raw").payload).toEqual(ade.payload)
  })

  test("unknown additive ADE events keep attribution and expose no summary payload", () => {
    const ade = record("FutureLifecycleFact", { payload: { text: "private", count: 2 } })
    expect(summarizeAdePayload(ade)).toEqual({})
    expect(busActivity(ade, ade.instanceId, 1, false, "summary")).toMatchObject({
      name: "FutureLifecycleFact",
      payload_mode: "summary",
      payload: {},
    })
  })
})

test("derives one stable Bus path and identifies retired socket residue", () => {
  expect(busSocketPathFor("/tmp/fmx-501-home.ade.sock")).toBe("/tmp/fmx-501-home.bus")
  expect(busSocketPathFor("/tmp/custom.sock")).toBe("/tmp/custom.bus")
  expect(busSocketPathFor("/tmp/fmx-501-home.ctl")).toBe("/tmp/fmx-501-home.bus")
  expect(busSocketPathFor("/tmp/fmx-501-home.obs")).toBe("/tmp/fmx-501-home.bus")
  expect(busSocketPathFor("/tmp/fmx-501-home.bus")).toBe("/tmp/fmx-501-home.bus")
  expect(retiredSocketPathsFor("/tmp/fmx-501-home.bus")).toEqual([
    "/tmp/fmx-501-home.ctl",
    "/tmp/fmx-501-home.obs",
  ])
})
