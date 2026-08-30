import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  decodeAgentWorkplacePayload,
  type AgentWorkplaceMessage,
} from "../src/agentworkplace-contracts.ts"
import {
  CONTRACT_MAX_FRAME_BYTES,
  ContractCodecError,
  ContractFrameDecoder,
  decodeContractFrame,
  decodeStrictJson,
  encodeCanonicalJson,
  encodeContractFrame,
  type ContractCodecErrorCode,
  type JsonValue,
} from "../src/contract-codec.ts"
import { NATIVE_SESSION_NAME_MAX_BYTES } from "../src/session-names.ts"
import { verifyAgentWorkplaceContracts } from "../scripts/check-agentworkplace-contracts.ts"

const FIXTURE_DIRECTORY = resolve(import.meta.dir, "../contracts/agentworkplace/v1")
const encoder = new TextEncoder()

describe("contract envelope refusal", () => {
  test("rejects unsupported and missing schema identities or versions", () => {
    expectCodec(
      () => decodeText('{"message_type":"ready","schema_id":"fmx.runtime-extension","schema_version":2}'),
      "unsupported_schema_version",
    )
    expectCodec(
      () => decodeText('{"message_type":"ready","schema_id":"foreign.runtime-extension","schema_version":1}'),
      "unsupported_schema",
    )
    expectCodec(() => decodeText('{"message_type":"ready","schema_version":1}'), "invalid_message")
    expectCodec(
      () => decodeText('{"message_type":"ready","schema_id":"fmx.runtime-extension"}'),
      "invalid_message",
    )
  })

  test("rejects noncanonical numeric versions, BOMs, whitespace, key order, and precision collapse", async () => {
    const ready = await fixtureMessage("runtime-extension.jsonl", "ready")
    const canonical = Buffer.from(encodeCanonicalJson(ready as JsonValue)).toString("utf8")
    for (const lexeme of ["1.0000000000000001", "0.99999999999999999"]) {
      expectCodec(
        () => decodeText(canonical.replace('"schema_version":1', `"schema_version":${lexeme}`)),
        "invalid_message",
      )
    }
    expectCodec(
      () => decodeAgentWorkplacePayload(Buffer.concat([Uint8Array.of(0xef, 0xbb, 0xbf), encoder.encode(canonical)])),
      "invalid_message",
    )
    expectCodec(() => decodeText(` ${canonical}`), "invalid_message")
    const reversed = JSON.stringify(Object.fromEntries(Object.entries(ready).reverse()))
    expectCodec(() => decodeText(reversed), "invalid_message")

    const snapshot = await fixtureMessage("runtime-extension.jsonl", "snapshot_result")
    ;((snapshot.agents as Array<Record<string, unknown>>)[0]!).extensions = {
      future_counter: 9_007_199_254_740_992,
    }
    const exact = Buffer.from(encodeCanonicalJson(snapshot as JsonValue)).toString("utf8")
    expectCodec(
      () => decodeText(exact.replace("9007199254740992", "9007199254740993")),
      "invalid_message",
    )
  })

  test("rejects missing, incompatible, mistyped, and unknown required fields", async () => {
    const ready = await fixtureMessage("runtime-extension.jsonl", "ready")

    const missing = clone(ready)
    delete missing.configuration_id
    expectInvalid(missing)

    const incompatible = clone(ready)
    incompatible.protocol_version = 2
    expectInvalid(incompatible)

    const wrongType = clone(ready)
    wrongType.fmx_session = ["session-beta"]
    expectInvalid(wrongType)

    const typo = clone(ready)
    typo.configuraton_id = typo.configuration_id
    expectInvalid(typo)

    const registration = await fixtureMessage("runtime-extension.jsonl", "registration")
    registration.required_capabilities = ["headless_liveness", "arbitrary_tui_injection"]
    expectInvalid(registration)
  })

  test("allows only deliberately additive capability and snapshot-Agent data", async () => {
    const ready = await fixtureMessage("runtime-extension.jsonl", "ready")
    ready.capabilities = [...ready.capabilities as string[], "future_safe_capability"]
    expect(() => decodeValue(ready)).not.toThrow()

    const result = await fixtureMessage("runtime-extension.jsonl", "snapshot_result")
    const agent = (result.agents as Array<Record<string, unknown>>)[0]!
    agent.extensions = { future_counter: 3, nested: { enabled: true } }
    expect(() => decodeValue(result)).not.toThrow()

    const topLevel = clone(result)
    topLevel.future_counter = 3
    expectInvalid(topLevel)

    const unsafeExtensionName = clone(result)
    ;((unsafeExtensionName.agents as Array<Record<string, unknown>>)[0]!).extensions = { "Future Counter": 3 }
    expectInvalid(unsafeExtensionName)

    const unsafeCapability = clone(ready)
    unsafeCapability.capabilities = ["headless_liveness", "unsafe capability"]
    expectInvalid(unsafeCapability)
  })

  test("rejects duplicate JSON keys before parsing can erase ambiguity", () => {
    expectCodec(
      () => decodeText('{"schema_id":"fmx.runtime-extension","schema_id":"fmx.agent-defaults","schema_version":1}'),
      "duplicate_key",
    )
    expectCodec(
      () => decodeText('{"schema_id":"fmx.runtime-extension","schem\\u0061_id":"fmx.runtime-extension","schema_version":1}'),
      "duplicate_key",
    )
    expectCodec(
      () => decodeText('{"schema_id":"fmx.runtime-extension","schema_version":1,"message_type":"snapshot_result","agents":[{"extensions":{"x":1,"x":2}}]}'),
      "duplicate_key",
    )
  })

  test("rejects duplicate or ambiguous identities inside valid JSON", async () => {
    const ready = await fixtureMessage("runtime-extension.jsonl", "ready")
    ready.capabilities = ["headless_liveness", "headless_liveness"]
    expectInvalid(ready)

    const association = await fixtureMessage("runtime-extension.jsonl", "association")
    const members = association.members as Array<Record<string, unknown>>
    members[1]!.fmx_session = members[0]!.fmx_session
    expectInvalid(association)

    const snapshot = await fixtureMessage("runtime-extension.jsonl", "snapshot_result")
    const agents = snapshot.agents as Array<Record<string, unknown>>
    agents.push({ ...clone(agents[0]!), pane_id: "p_22222222222222222222222222222222", display_id: 8 })
    expectInvalid(snapshot)

    const defaults = await fixtureMessage("agent-defaults.jsonl", "defaults_table")
    const entries = defaults.entries as Array<Record<string, unknown>>
    entries.push(clone(entries[0]!))
    expectInvalid(defaults)
  })

  test("rejects inverted protocol ranges and impossible complete receipts", async () => {
    const registration = await fixtureMessage("runtime-extension.jsonl", "registration")
    registration.protocol = { maximum: 1, minimum: 2 }
    expectInvalid(registration)

    const complete = (await fixtureMessages("ensure-lifecycle.jsonl", "ensure_receipt"))
      .find((message) => message.status === "complete")!
    ;((complete.effects as Record<string, unknown>).fx as Record<string, unknown>) = { status: "pending" }
    expectInvalid(complete)
  })

  test("allows pre-admission cancellation after Fx creation but requires it when Conversation is absent", async () => {
    const requests = await fixtureMessages("ensure-lifecycle.jsonl", "end_request")
    const withConversation = requests.find((message) => message.conversation_id !== null)!
    withConversation.reason = "cancelled_before_start"
    expect(() => decodeValue(withConversation)).not.toThrow()

    const withoutConversation = requests.find((message) => message.conversation_id === null)!
    withoutConversation.reason = "stop"
    expectInvalid(withoutConversation)
  })

  test("enforces canonical unsigned-64-bit revisions and Turn ids", async () => {
    const invalidated = await fixtureMessage("runtime-extension.jsonl", "snapshot_invalidated")
    invalidated.revision = "18446744073709551615"
    expect(() => decodeValue(invalidated)).not.toThrow()
    invalidated.revision = "18446744073709551616"
    expectInvalid(invalidated)
    invalidated.revision = "07"
    expectInvalid(invalidated)

    const decision = (await fixtureMessages("fx-launch-admission-final.jsonl", "admission_decision"))
      .find((message) => (message.decision as Record<string, unknown>).kind === "admitted")!
    ;(decision.decision as Record<string, unknown>).turn_id = "18446744073709551615"
    expect(() => decodeValue(decision)).not.toThrow()
    ;(decision.decision as Record<string, unknown>).turn_id = "18446744073709551616"
    expectInvalid(decision)
  })

  test("enforces explicit-field precedence rather than trusting claimed sources", async () => {
    const resolution = (await fixtureMessages("agent-defaults.jsonl", "resolution_case"))[0]!
    ;(resolution.sources as Record<string, unknown>).model = "session_default"
    ;(resolution.resolved_launch as Record<string, unknown>).model = "fixture/model-default"
    expectInvalid(resolution)
  })
})

describe("bounded text and path refusal", () => {
  test("rejects terminal controls and blank bounded text", async () => {
    const card = await fixtureMessage("runtime-extension.jsonl", "unavailable_slot_publish")
    ;(card.card as Record<string, unknown>).message = "unsafe\u001b[31mtext"
    expectInvalid(card)

    const launch = await fixtureMessage("fx-launch-admission-final.jsonl", "launch_request")
    launch.conversation_name = "unsafe\nname"
    expectInvalid(launch)
    launch.conversation_name = "   "
    expectInvalid(launch)
  })

  test("pins exact byte bounds for identities, names, human text, model fields, and paths", async () => {
    const ready = await fixtureMessage("runtime-extension.jsonl", "ready")
    ready.request_id = "r".repeat(128)
    expect(() => decodeValue(ready)).not.toThrow()
    ready.request_id = "r".repeat(129)
    expectInvalid(ready)

    const launch = await fixtureMessage("fx-launch-admission-final.jsonl", "launch_request")
    launch.conversation_name = "n".repeat(NATIVE_SESSION_NAME_MAX_BYTES)
    expect(() => decodeValue(launch)).not.toThrow()
    launch.conversation_name = "n".repeat(NATIVE_SESSION_NAME_MAX_BYTES + 1)
    expectInvalid(launch)
    launch.conversation_name = "fixture"
    launch.directory = `/${"p".repeat(4095)}`
    expect(() => decodeValue(launch)).not.toThrow()
    launch.directory = `/${"p".repeat(4096)}`
    expectInvalid(launch)

    const publish = await fixtureMessage("runtime-extension.jsonl", "unavailable_slot_publish")
    const card = publish.card as Record<string, unknown>
    card.title = "t".repeat(96)
    card.message = "m".repeat(1024)
    expect(() => decodeValue(publish)).not.toThrow()
    card.title = "t".repeat(97)
    expectInvalid(publish)
    card.title = "title"
    card.message = "m".repeat(1025)
    expectInvalid(publish)

    const defaults = await fixtureMessage("agent-defaults.jsonl", "defaults_table")
    const entry = (defaults.entries as Array<Record<string, unknown>>)[1]!
    entry.model = "m".repeat(160)
    entry.effort = "e".repeat(64)
    expect(() => decodeValue(defaults)).not.toThrow()
    entry.model = "m".repeat(161)
    expectInvalid(defaults)
    entry.model = "model"
    entry.effort = "e".repeat(65)
    expectInvalid(defaults)

    const ensure = await fixtureMessage("ensure-lifecycle.jsonl", "ensure_request")
    ;(ensure.planned_worktree as Record<string, unknown>).branch = "b".repeat(256)
    expect(() => decodeValue(ensure)).not.toThrow()
    ;(ensure.planned_worktree as Record<string, unknown>).branch = "b".repeat(257)
    expectInvalid(ensure)

    const cleanup = await fixtureMessage("ensure-lifecycle.jsonl", "cleanup_receipt")
    ;(cleanup.outcome as Record<string, unknown>).untracked_paths = ["u".repeat(1024)]
    expect(() => decodeValue(cleanup)).not.toThrow()
    ;(cleanup.outcome as Record<string, unknown>).untracked_paths = ["u".repeat(1025)]
    expectInvalid(cleanup)
  })

  test("rejects relative, unnormalized, and escaping paths", async () => {
    const launch = await fixtureMessage("fx-launch-admission-final.jsonl", "launch_request")
    launch.directory = "/tmp/work/../foreign"
    expectInvalid(launch)

    const relative = clone(launch)
    relative.directory = "worktree/fixture"
    expectInvalid(relative)

    const cleanup = await fixtureMessage("ensure-lifecycle.jsonl", "cleanup_receipt")
    const outcome = cleanup.outcome as Record<string, unknown>
    outcome.untracked_paths = ["../foreign-secret"]
    expectInvalid(cleanup)
  })

  test("rejects root, aliased executable, equal repository/Worktree, and controlled paths", async () => {
    const launch = await fixtureMessage("fx-launch-admission-final.jsonl", "launch_request")
    launch.directory = "/"
    expectInvalid(launch)
    launch.directory = "/tmp/unsafe\npath"
    expectInvalid(launch)

    const ensure = await fixtureMessage("ensure-lifecycle.jsonl", "ensure_request")
    const planned = ensure.planned_worktree as Record<string, unknown>
    planned.directory = planned.repository
    expectInvalid(ensure)

    const registration = await fixtureMessage("runtime-extension.jsonl", "registration")
    registration.argv = ["/opt/fixture/../foreign/extension"]
    expectInvalid(registration)
  })

  test("rejects impossible calendar timestamps", async () => {
    const end = await fixtureMessage("ensure-lifecycle.jsonl", "end_receipt")
    ;(end.proof as Record<string, unknown>).observed_at = "2026-99-99T99:99:99Z"
    expectInvalid(end)
  })

  test("rejects malformed UTF-8, raw controls, unpaired surrogates, and excessive nesting", () => {
    expectCodec(() => decodeStrictJson(Uint8Array.of(0xc3, 0x28)), "invalid_utf8")
    expectCodec(() => decodeStrictJson(encoder.encode('"raw\u0001control"')), "malformed_json")
    expectCodec(() => decodeStrictJson(encoder.encode('"\\ud800"')), "invalid_message")
    expectCodec(() => decodeStrictJson(encoder.encode(`${"[".repeat(66)}null${"]".repeat(66)}`)), "malformed_json")
  })

  test("rejects sparse arrays before canonical encoding can collapse them", () => {
    expectCodec(() => encodeCanonicalJson(new Array(1) as JsonValue), "invalid_message")
  })
})

describe("bounded framed codec refusal", () => {
  test("rejects empty, short, truncated, trailing, and oversized frames", () => {
    expectCodec(() => encodeContractFrame(new Uint8Array()), "empty_frame")
    expectCodec(() => decodeContractFrame(Uint8Array.of(0, 0, 0)), "malformed_frame")

    const payload = encoder.encode("{}")
    const valid = encodeContractFrame(payload)
    expectCodec(() => decodeContractFrame(valid.subarray(0, -1)), "malformed_frame")
    expectCodec(() => decodeContractFrame(Buffer.concat([valid, Uint8Array.of(0)])), "malformed_frame")

    const oversizedHeader = new Uint8Array(4)
    new DataView(oversizedHeader.buffer).setUint32(0, CONTRACT_MAX_FRAME_BYTES + 1, false)
    expectCodec(() => decodeContractFrame(oversizedHeader), "frame_too_large")
    expectCodec(() => new ContractFrameDecoder().push(oversizedHeader), "frame_too_large")
    expectCodec(
      () => decodeAgentWorkplacePayload(new Uint8Array(CONTRACT_MAX_FRAME_BYTES + 1)),
      "frame_too_large",
    )
  })

  test("accepts the exact frame bound and rejects one byte over", () => {
    const exact = new Uint8Array(CONTRACT_MAX_FRAME_BYTES)
    expect(encodeContractFrame(exact).byteLength).toBe(CONTRACT_MAX_FRAME_BYTES + 4)
    expectCodec(() => encodeContractFrame(new Uint8Array(CONTRACT_MAX_FRAME_BYTES + 1)), "frame_too_large")
  })

  test("rejects streaming EOF with a partial header or payload", () => {
    const partialHeader = new ContractFrameDecoder()
    partialHeader.push(Uint8Array.of(0, 0, 0))
    expectCodec(() => partialHeader.finish(), "malformed_frame")

    const partialPayload = new ContractFrameDecoder()
    partialPayload.push(Uint8Array.of(0, 0, 0, 4, 0x7b, 0x7d))
    expectCodec(() => partialPayload.finish(), "malformed_frame")

    const complete = new ContractFrameDecoder()
    complete.push(encodeContractFrame(encoder.encode("{}")))
    expect(() => complete.finish()).not.toThrow()
  })

  test("rejects malformed JSON and trailing JSON values inside a well-sized frame", () => {
    expectCodec(() => decodeText("{"), "malformed_json")
    expectCodec(() => decodeText("{} {}"), "malformed_json")
    expectCodec(() => decodeText("[1,]"), "malformed_json")
  })
})

describe("fixture false-pass refusal", () => {
  test("a changed fixture cannot pass its recorded artifact digest", async () => {
    const directory = await temporaryContractDirectory()
    try {
      const path = join(directory, "agent-defaults.jsonl")
      const bytes = await readFile(path)
      bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b
      await writeFile(path, bytes)
      await expect(verifyAgentWorkplaceContracts(directory)).rejects.toThrow("digest")
    } finally {
      await rm(resolve(directory, ".."), { recursive: true, force: true })
    }
  })

  test("rejects nonoverlapping protocol ranges and omitted required capabilities after rehash", async () => {
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      const registration = one(messages, "registration")
      registration.protocol = { maximum: 3, minimum: 2 }
    }, "protocol range does not include v1")

    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      const ready = one(messages, "ready")
      ready.capabilities = ["headless_liveness", "member_present_focus", "member_snapshot_pull"]
    }, "readiness omits a registration-required capability")
  })

  test("rejects initialize/ready association and member drift after rehash", async () => {
    for (const field of [
      "request_id",
      "workplace_instance_id",
      "extension_id",
      "configuration_id",
      "placement_id",
      "fmx_session",
    ]) {
      await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
        one(messages, "ready")[field] = field === "fmx_session" ? "session-alpha" : `drift-${field}`
      }, field === "fmx_session" || field === "placement_id" ? "correlation mismatch" : "correlation mismatch")
    }
  })

  test("rejects snapshot id, revision, Session, and result correlation drift after rehash", async () => {
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      one(messages, "snapshot_result").request_id = "snapshot-request-drift"
    }, "snapshot result lacks its exact request")
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      one(messages, "snapshot_result").revision = "6"
    }, "predates the invalidated")
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      one(messages, "snapshot_invalidated").fmx_session = "session-alpha"
    }, "snapshot envelopes name different")
  })

  test("rejects response/request and response/operation drift after rehash", async () => {
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      const response = messages.find((message) =>
        message.message_type === "response" && message.operation === "present"
      )!
      response.request_id = "response-request-drift"
    }, "lacks one correlated response")
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      const response = messages.find((message) =>
        message.message_type === "response" && message.operation === "present"
      )!
      response.operation = "unavailable_slot_publish"
    }, "response operation mismatch")

    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      const response = messages.find((message) =>
        message.message_type === "response" && message.operation === "present"
      )!
      delete response.status
      response.ok = false
      response.error = { code: "unavailable", message: "fixture refusal" }
    }, "fixture outcome must be accepted")
  })

  test("rejects duplicate Runtime request ids and orphan snapshot outcomes after rehash", async () => {
    await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
      const gets = messages.filter((message) => message.message_type === "snapshot_get")
      gets[1]!.request_id = gets[0]!.request_id
    }, "duplicate snapshot request id")
  })

  test("rejects recovery-card slot, revision, action, and clear drift after rehash", async () => {
    for (const [messageType, field, expected] of [
      ["unavailable_slot_action", "slot_id", "correlation mismatch"],
      ["unavailable_slot_action", "card_revision", "correlation mismatch"],
      ["unavailable_slot_action", "action_id", "recovery-card"],
      ["unavailable_slot_clear", "slot_id", "correlation mismatch"],
    ] as const) {
      await expectFixtureMutation("runtime-extension.jsonl", (messages) => {
        one(messages, messageType)[field] = field === "card_revision" ? "13" : `drift-${field}`
      }, expected)
    }
  })

  test("rejects changed ensure specification, outer correlation, and inner effects after rehash", async () => {
    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const request = messages.find((message) =>
        message.message_type === "ensure_request" && message.ensure_id === "ensure-a"
      )!
      ;(request.planned_worktree as Record<string, unknown>).branch = "changed-fixture-contracts"
    }, "ensure request digest")

    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const partial = messages.find((message) =>
        message.message_type === "ensure_receipt" && message.status === "in_progress"
      )!
      partial.launch_id = "launch-drift"
    }, "correlation mismatch for launch_id")

    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const complete = messages.find((message) =>
        message.message_type === "ensure_receipt" && message.status === "complete"
      )!
      const effects = complete.effects as Record<string, Record<string, unknown>>
      effects.worktree!.directory = "/var/tmp/fmx-contract-fixture/worktree-drift"
      refreshReceiptDigest(messages, complete)
    }, "ensure effect changed the planned Worktree path")
  })

  test("rejects reused Worktree, Agent, and Worktree-directory identities across ensure traces", async () => {
    for (const [field, expected] of [
      ["worktree_id", "duplicate Worktree id"],
      ["agent_id", "duplicate Agent id"],
    ] as const) {
      await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
        const requests = messages.filter((message) => message.message_type === "ensure_request")
        requests[1]![field] = requests[0]![field]
      }, expected)
    }

    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const requests = messages.filter((message) => message.message_type === "ensure_request")
      const first = requests[0]!.planned_worktree as Record<string, unknown>
      const second = requests[1]!.planned_worktree as Record<string, unknown>
      second.directory = first.directory
    }, "duplicate planned Worktree directory")
  })

  test("rejects reused Companion session and pane identities across ensure traces", async () => {
    for (const [effectField, proofField, expected] of [
      ["session_name", "companion_session", "duplicate Companion session name"],
      ["pane_id", "pane_id", "duplicate Companion pane id"],
    ] as const) {
      await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
        const firstReceipt = messages.find((message) =>
          message.message_type === "ensure_receipt" && message.ensure_id === "ensure-a"
        )!
        const firstCompanion = (firstReceipt.effects as Record<string, Record<string, unknown>>).companion!
        for (const receipt of messages.filter((message) =>
          message.message_type === "ensure_receipt" && message.ensure_id === "ensure-b"
        )) {
          const effects = receipt.effects as Record<string, Record<string, unknown>>
          effects.companion![effectField] = firstCompanion[effectField]
          refreshReceiptDigest(messages, receipt)
        }
        const endReceipt = messages.find((message) =>
          message.message_type === "end_receipt" && message.ensure_id === "ensure-b"
        )!
        ;(endReceipt.proof as Record<string, unknown>)[proofField] = firstCompanion[effectField]
        refreshReceiptDigest(messages, endReceipt)
      }, expected)
    }
  })

  test("rejects duplicate lifecycle receipts even when an orphan acknowledgement masks the count", async () => {
    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const partial = messages.find((message) =>
        message.message_type === "ensure_receipt" && message.ensure_id === "ensure-a" &&
        message.status === "in_progress"
      )!
      messages.push(clone(partial))
      messages.push({
        schema_id: "fmx.ensure-lifecycle",
        schema_version: 1,
        message_type: "receipt_acknowledgement",
        acknowledgement_id: "orphan-ack",
        receipt_kind: "ensure",
        receipt_id: "orphan-receipt",
        receipt_digest: "0".repeat(64),
        ensure_id: "ensure-a",
      })
    }, "duplicate lifecycle receipt id")
  })

  test("rejects end/cleanup identity and path drift after rehash", async () => {
    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const receipt = messages.find((message) =>
        message.message_type === "end_receipt" && message.ensure_id === "ensure-a"
      )!
      receipt.end_id = "end-drift"
    }, "correlation mismatch for end_id")
    await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
      const request = messages.find((message) =>
        message.message_type === "cleanup_request" && message.ensure_id === "ensure-a"
      )!
      request.worktree_directory = "/var/tmp/fmx-contract-fixture/worktree-drift"
    }, "cleanup request does not name the immutable planned Worktree")
  })

  test("rejects every lifecycle acknowledgement when it points at another exact receipt", async () => {
    for (const acknowledgementId of [
      "ensure-ack-a-partial",
      "ensure-ack-a-complete",
      "end-ack-a",
      "cleanup-ack-a",
    ]) {
      await expectFixtureMutation("ensure-lifecycle.jsonl", (messages) => {
        const acknowledgements = messages.filter((message) => message.message_type === "receipt_acknowledgement")
        const target = acknowledgements.find((message) => message.acknowledgement_id === acknowledgementId)!
        const replacement = acknowledgements.find((message) => message.acknowledgement_id !== acknowledgementId)!
        target.receipt_id = replacement.receipt_id
        target.receipt_digest = replacement.receipt_digest
        target.receipt_kind = replacement.receipt_kind
      }, "lacks its exact acknowledgement")
    }
  })

  test("rejects Fx launch, decision, cancellation, final, and acknowledgement drift after rehash", async () => {
    await expectFixtureMutation("fx-launch-admission-final.jsonl", (messages) => {
      const launch = messages.find((message) =>
        message.message_type === "launch_request" && message.launch_id === "launch-a"
      )!
      launch.model = "fixture/model-drift"
    }, "Fx launch request digest")

    await expectFixtureMutation("fx-launch-admission-final.jsonl", (messages) => {
      const receipt = messages.find((message) =>
        message.message_type === "launch_receipt" && message.launch_id === "launch-a"
      )!
      receipt.request_id = "fx-launch-request-drift"
    }, "launch receipt does not match its exact request")
    await expectFixtureMutation("fx-launch-admission-final.jsonl", (messages) => {
      const admitted = messages.find((message) =>
        message.message_type === "admission_decision" &&
        (message.decision as Record<string, unknown>).kind === "admitted"
      )!
      admitted.launch_digest = "f".repeat(64)
    }, "correlation mismatch for launch_digest")
    await expectFixtureMutation("fx-launch-admission-final.jsonl", (messages) => {
      const cancelled = messages.find((message) =>
        message.message_type === "admission_decision" &&
        (message.decision as Record<string, unknown>).kind === "cancelled_before_start"
      )!
      ;(cancelled.decision as Record<string, unknown>).cancellation_request_id = "fx-cancel-request-drift"
      refreshReceiptDigest(messages, cancelled)
    }, "exact cancellation request")
    await expectFixtureMutation("fx-launch-admission-final.jsonl", (messages) => {
      one(messages, "final_receipt_acknowledgement").conversation_id = "1788999999999-1788999999999000000-deadbeef"
    }, "correlation mismatch for conversation_id")
  })

  test("rejects duplicate Fx request and receipt identities across launches after rehash", async () => {
    await expectFixtureMutation("fx-launch-admission-final.jsonl", (messages) => {
      const launchA = messages.find((message) =>
        message.message_type === "launch_request" && message.launch_id === "launch-a"
      )!
      const launchB = messages.find((message) =>
        message.message_type === "launch_request" && message.launch_id === "launch-b"
      )!
      launchB.request_id = launchA.request_id
      const receiptA = messages.find((message) =>
        message.message_type === "launch_receipt" && message.launch_id === "launch-a"
      )!
      const receiptB = messages.find((message) =>
        message.message_type === "launch_receipt" && message.launch_id === "launch-b"
      )!
      receiptB.request_id = launchA.request_id
      receiptB.receipt_id = receiptA.receipt_id
    }, "duplicate Fx boundary request id")
  })

  test("rejects unknown/admitted-plus-cancelled decisions instead of inferring cancellation", async () => {
    const decisions = await fixtureMessages("fx-launch-admission-final.jsonl", "admission_decision")
    const admitted = decisions.find((message) =>
      (message.decision as Record<string, unknown>).kind === "admitted"
    )!
    ;(admitted.decision as Record<string, unknown>).cancellation_request_id = "cancel-extra"
    expectInvalid(admitted)

    const cancelled = decisions.find((message) =>
      (message.decision as Record<string, unknown>).kind === "cancelled_before_start"
    )!
    cancelled.decision = { kind: "unknown" }
    expectInvalid(cancelled)
  })
})

async function fixtureMessage(file: string, messageType: string): Promise<Record<string, unknown>> {
  const messages = await fixtureMessages(file, messageType)
  if (messages.length === 0) throw new Error(`${file} has no ${messageType}`)
  return messages[0]!
}

async function fixtureMessages(file: string, messageType: string): Promise<Record<string, unknown>[]> {
  const lines = (await readFile(resolve(FIXTURE_DIRECTORY, file), "utf8")).trimEnd().split("\n")
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message) => message.message_type === messageType)
    .map(clone)
}

function one(messages: Record<string, unknown>[], messageType: string): Record<string, unknown> {
  const matches = messages.filter((message) => message.message_type === messageType)
  if (matches.length !== 1) throw new Error(`expected one ${messageType}; found ${matches.length}`)
  return matches[0]!
}

function decodeText(text: string): AgentWorkplaceMessage {
  return decodeAgentWorkplacePayload(encoder.encode(text))
}

function decodeValue(value: Record<string, unknown>): AgentWorkplaceMessage {
  return decodeAgentWorkplacePayload(encodeCanonicalJson(value as JsonValue))
}

function expectInvalid(value: Record<string, unknown>): void {
  expectCodec(() => decodeValue(value), "invalid_message")
}

function expectCodec(action: () => unknown, code: ContractCodecErrorCode): void {
  try {
    action()
    throw new Error(`expected ContractCodecError ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ContractCodecError)
    expect((error as ContractCodecError).code).toBe(code)
  }
}

async function expectFixtureMutation(
  file: string,
  mutate: (messages: Record<string, unknown>[]) => void,
  expected: string,
): Promise<void> {
  const directory = await temporaryContractDirectory()
  try {
    const path = join(directory, file)
    const messages = (await readFile(path, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    mutate(messages)
    const bytes = Buffer.from(`${messages.map((message) =>
      Buffer.from(encodeCanonicalJson(message as JsonValue)).toString("utf8")
    ).join("\n")}\n`)
    await writeFile(path, bytes)

    const manifestPath = join(directory, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    const files = manifest.files as Array<Record<string, unknown>>
    const entry = files.find((candidate) => candidate.path === file)!
    entry.bytes = bytes.byteLength
    entry.messages = messages.length
    entry.sha256 = sha256(bytes)
    await writeFile(manifestPath, Buffer.concat([
      Buffer.from(encodeCanonicalJson(manifest as JsonValue)),
      Buffer.from("\n"),
    ]))

    await expect(verifyAgentWorkplaceContracts(directory)).rejects.toThrow(expected)
  } finally {
    await rm(resolve(directory, ".."), { recursive: true, force: true })
  }
}

function refreshReceiptDigest(
  messages: Record<string, unknown>[],
  receipt: Record<string, unknown>,
): void {
  const content = { ...receipt }
  delete content.receipt_digest
  receipt.receipt_digest = sha256(encodeCanonicalJson(content as JsonValue))
  const acknowledgement = messages.find((message) =>
    (message.message_type === "receipt_acknowledgement" ||
      message.message_type === "final_receipt_acknowledgement") &&
    message.receipt_id === receipt.receipt_id
  )
  if (acknowledgement) acknowledgement.receipt_digest = receipt.receipt_digest
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function temporaryContractDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fmx-awp-contracts-"))
  const directory = join(root, "v1")
  await cp(FIXTURE_DIRECTORY, directory, { recursive: true })
  return directory
}
