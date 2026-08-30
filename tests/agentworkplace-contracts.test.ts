import { describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import {
  AGENT_DEFAULTS_SCHEMA_ID,
  AGENTWORKPLACE_CONTRACT_VERSION,
  AGENTWORKPLACE_SCHEMA_IDS,
  ENSURE_LIFECYCLE_SCHEMA_ID,
  FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplaceFrame,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  encodeAgentWorkplacePayload,
} from "../src/agentworkplace-contracts.ts"
import {
  CONTRACT_FRAME_HEADER_BYTES,
  CONTRACT_MAX_FRAME_BYTES,
  ContractFrameDecoder,
} from "../src/contract-codec.ts"
import { verifyAgentWorkplaceContracts } from "../scripts/check-agentworkplace-contracts.ts"

const FIXTURE_DIRECTORY = resolve(import.meta.dir, "../contracts/agentworkplace/v1")

describe("fmx AgentWorkplace Phase 0 golden contracts", () => {
  test("the manifest pins every canonical owner and digest", async () => {
    const verified = await verifyAgentWorkplaceContracts(FIXTURE_DIRECTORY)
    expect(verified).toMatchObject({
      schema_version: 1,
      ok: true,
      manifest_sha256: "e02dca149a4b1875eb9dedc1f07fc21cb91d106d0844eacb1806960531e6e17f",
      fixtures: [
        {
          path: "agent-defaults.jsonl",
          schema_id: AGENT_DEFAULTS_SCHEMA_ID,
          sha256: "d9f9858ad5a8593bdb7f8833d23da043b7b364673baaed32d2f24f1db6910265",
          messages: 5,
        },
        {
          path: "ensure-lifecycle.jsonl",
          schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
          sha256: "97c7bbd64cb81186f2bfc8268be48e6152955d0ed6f2336b4061004df93c93a2",
          messages: 20,
        },
        {
          path: "fx-launch-admission-final.jsonl",
          schema_id: FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
          sha256: "b807e31bf8f4de4179b91cca4c9f3a9a40d572f98d8e5467242fc70908eb8161",
          messages: 9,
        },
        {
          path: "runtime-extension.jsonl",
          schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
          sha256: "0ae7816c752eadf31dfa47651f0e37d64d72d272624046903b9f3519d982b88d",
          messages: 17,
        },
      ],
    })
  })

  test("the golden traces bind launch controls and distinguish ended from never started", async () => {
    const lifecycle = (await readFile(resolve(FIXTURE_DIRECTORY, "ensure-lifecycle.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const proofs = lifecycle
      .filter((message) => message.message_type === "end_receipt")
      .map((message) => (message.proof as Record<string, unknown>).kind)
    expect(proofs).toEqual(["ended", "never_started"])
    expect(lifecycle.find((message) => message.ensure_id === "ensure-b" && message.message_type === "end_request"))
      .toMatchObject({ conversation_id: null, reason: "cancelled_before_start" })

    const launches = (await readFile(resolve(FIXTURE_DIRECTORY, "fx-launch-admission-final.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message.message_type === "launch_request")
    expect(launches).toHaveLength(2)
    for (const launch of launches) {
      expect(launch).toMatchObject({
        model: "fixture/model-default",
        effort: "medium",
      })
      expect(launch.remaining_launch_controls_digest).toMatch(/^[0-9a-f]{64}$/u)
    }
  })

  test("every JSONL envelope is exact canonical payload and framed bytes", async () => {
    const files = (await readdir(FIXTURE_DIRECTORY)).filter((file) => file.endsWith(".jsonl"))
    for (const file of files) {
      const bytes = await readFile(resolve(FIXTURE_DIRECTORY, file))
      expect(bytes.at(-1)).toBe(0x0a)
      for (const line of bytes.subarray(0, -1).toString("utf8").split("\n")) {
        const payload = new TextEncoder().encode(line)
        const decoded = decodeAgentWorkplacePayload(payload)
        expect(Buffer.from(encodeAgentWorkplacePayload(decoded))).toEqual(Buffer.from(payload))

        const frame = encodeAgentWorkplaceFrame(decoded)
        expect(frame.byteLength).toBe(CONTRACT_FRAME_HEADER_BYTES + payload.byteLength)
        expect(new DataView(frame.buffer, frame.byteOffset).getUint32(0, false)).toBe(payload.byteLength)
        expect(decodeAgentWorkplaceFrame(frame)).toEqual(decoded)
      }
    }
  })

  test("pins the v1 identities, capability vocabulary, and frame bound", () => {
    expect(AGENTWORKPLACE_CONTRACT_VERSION).toBe(1)
    expect(AGENTWORKPLACE_SCHEMA_IDS).toEqual([
      "fmx.runtime-extension",
      "fmx.agent-defaults",
      "fmx.ensure-lifecycle",
      "fx.launch-admission-final",
    ])
    expect(RUNTIME_EXTENSION_CAPABILITIES).toEqual([
      "headless_liveness",
      "member_present_focus",
      "member_snapshot_pull",
      "unavailable_slot_recovery_action",
    ])
    expect(CONTRACT_MAX_FRAME_BYTES).toBe(1_048_576)
  })

  test("the stream codec preserves fragmented and coalesced golden envelopes", async () => {
    const lines = (await readFile(resolve(FIXTURE_DIRECTORY, "agent-defaults.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
    const frames = lines.map((line) => encodeAgentWorkplaceFrame(
      decodeAgentWorkplacePayload(new TextEncoder().encode(line)),
    ))
    const bytes = Buffer.concat(frames)
    const decoder = new ContractFrameDecoder()
    const payloads: Uint8Array[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += 7) {
      payloads.push(...decoder.push(bytes.subarray(offset, offset + 7)))
    }
    decoder.finish()
    expect(decoder.pendingBytes).toBe(0)
    expect(payloads.map((payload) => decodeAgentWorkplacePayload(payload).message_type)).toEqual([
      "defaults_table",
      "resolution_case",
      "resolution_case",
      "resolution_case",
      "resolution_case",
    ])
  })
})
