import { describe, expect, test } from "bun:test"
import {
  decodeObservationSubscription,
  encodeObservationSubscription,
  observationActivity,
  OBSERVATION_SCHEMA_VERSION,
  summarizeAdePayload,
} from "../src/observation-protocol.ts"
import { record } from "./fixtures/ade-feed.ts"

describe("observation subscriptions", () => {
  test("encodes the versioned wire shape and decodes explicit choices", () => {
    const encoded = encodeObservationSubscription({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      topics: ["state", "activity"],
      activityPayload: "raw",
    })
    expect(encoded.endsWith("\n")).toBe(true)
    expect(JSON.parse(encoded)).toEqual({
      schema_version: 1,
      topics: ["state", "activity"],
      activity_payload: "raw",
    })
    expect(decodeObservationSubscription(encoded)).toEqual({
      subscription: {
        schemaVersion: 1,
        topics: ["state", "activity"],
        activityPayload: "raw",
      },
    })
  })

  test("defaults to state with summarized activity payloads", () => {
    expect(decodeObservationSubscription('{"schema_version":1}')).toEqual({
      subscription: {
        schemaVersion: 1,
        topics: ["state"],
        activityPayload: "summary",
      },
    })
  })

  test("rejects malformed requests, unsupported schemas, and unknown values", () => {
    expect(decodeObservationSubscription("nope")).toMatchObject({ error: { code: "invalid_request" } })
    expect(decodeObservationSubscription('{"schema_version":2}')).toMatchObject({
      error: { code: "unsupported_schema_version" },
    })
    expect(decodeObservationSubscription('{"schema_version":1,"topics":[]}')).toMatchObject({
      error: { code: "invalid_request" },
    })
    expect(decodeObservationSubscription('{"schema_version":1,"topics":["metrics"]}')).toMatchObject({
      error: { code: "invalid_request" },
    })
    expect(
      decodeObservationSubscription('{"schema_version":1,"activity_payload":"everything"}'),
    ).toMatchObject({ error: { code: "invalid_request" } })
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

    expect(observationActivity(ade, "agent-stable-id", 4, true, "summary")).toEqual({
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
    expect(observationActivity(ade, ade.instanceId, 1, false, "raw").payload).toEqual(ade.payload)
  })

  test("unknown additive ADE events keep attribution and expose no summary payload", () => {
    const ade = record("FutureLifecycleFact", { payload: { text: "private", count: 2 } })
    expect(summarizeAdePayload(ade)).toEqual({})
    expect(observationActivity(ade, ade.instanceId, 1, false, "summary")).toMatchObject({
      name: "FutureLifecycleFact",
      payload_mode: "summary",
      payload: {},
    })
  })
})
