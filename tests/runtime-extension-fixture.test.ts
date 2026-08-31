import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  RUNTIME_EXTENSION_CAPABILITIES,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  type AgentWorkplaceMessage,
} from "../src/agentworkplace-contracts.ts"
import { ContractFrameDecoder } from "../src/contract-codec.ts"

const FIXTURE = fileURLToPath(new URL("./fixtures/runtime-extension.ts", import.meta.url))

test("the fixture child keeps stdout protocol-only and completes exact readiness", async () => {
  const child = Bun.spawn([process.execPath, FIXTURE], {
    env: { ...process.env, FMX_FIXTURE_EXTENSION_MODE: "ready" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const frames = new FixtureFrameReader(child.stdout)
  try {
    child.stdin.write(encodeAgentWorkplaceFrame({
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "initialize",
      request_id: "fixture-initialize",
      workplace_instance_id: "fixture-workplace",
      extension_id: "fixture-extension",
      configuration_id: "fixture-configuration",
      placement_id: "fixture-placement",
      fmx_session: "fixture-session",
      protocol_version: 1,
    }))
    await child.stdin.flush()
    const ready = await Promise.race([
      frames.next(),
      Bun.sleep(2_000).then(() => {
        throw new Error("fixture readiness timed out")
      }),
    ])
    expect(ready).toMatchObject({
      message_type: "ready",
      request_id: "fixture-initialize",
      workplace_instance_id: "fixture-workplace",
      extension_id: "fixture-extension",
      configuration_id: "fixture-configuration",
      placement_id: "fixture-placement",
      fmx_session: "fixture-session",
      capabilities: [...RUNTIME_EXTENSION_CAPABILITIES, "fixture_observability"],
    })
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  } finally {
    frames.close()
    child.kill()
    await child.exited
  }
})

test("the fixture deterministically pulls snapshots and relays one opaque card action", async () => {
  const child = Bun.spawn([process.execPath, FIXTURE], {
    env: {
      ...process.env,
      FMX_FIXTURE_EXTENSION_MODE: "ready",
      FMX_FIXTURE_EXTENSION_AUTO_SNAPSHOT: "1",
      FMX_FIXTURE_EXTENSION_PRESENT_FOCUS: "false",
      FMX_FIXTURE_EXTENSION_CLEAR_AFTER_ACTION: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const frames = new FixtureFrameReader(child.stdout)
  const agentId = "1".repeat(32)
  try {
    write(child, {
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "initialize",
      request_id: "fixture-initialize",
      workplace_instance_id: "fixture-workplace",
      extension_id: "fixture-extension",
      configuration_id: "fixture-configuration",
      placement_id: "fixture-placement",
      fmx_session: "fixture-session",
      protocol_version: 1,
    })
    expect(await frames.next()).toMatchObject({ message_type: "ready" })

    write(child, {
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "snapshot_invalidated",
      fmx_session: "fixture-session",
      revision: "7",
    })
    const pull = await frames.next()
    expect(pull).toMatchObject({
      message_type: "snapshot_get",
      fmx_session: "fixture-session",
      after_revision: null,
    })
    if (!("request_id" in pull)) throw new Error("snapshot pull has no request id")
    write(child, {
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "snapshot_result",
      request_id: pull.request_id,
      fmx_session: "fixture-session",
      revision: "7",
      selected_agent_id: agentId,
      agents: [{
        agent_id: agentId,
        pane_id: `p_${agentId}`,
        display_id: 1,
        created_at_ms: 1,
        lifecycle: "running",
        state: "working",
        attention: null,
        directory: process.cwd(),
        worktree: true,
        fx_conversation: null,
        correlation: null,
      }],
    })
    expect(await frames.next()).toMatchObject({
      message_type: "present",
      agent_id: agentId,
      focus: false,
    })

    write(child, {
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "unavailable_slot_action",
      request_id: "runtime-card-action",
      fmx_session: "fixture-session",
      slot_id: "fixture-slot",
      card_revision: "9",
      action_id: "fixture-action",
    })
    expect(await frames.next()).toEqual({
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "response",
      request_id: "runtime-card-action",
      operation: "unavailable_slot_action",
      ok: true,
      status: "accepted",
    })
    expect(await frames.next()).toMatchObject({
      message_type: "unavailable_slot_clear",
      fmx_session: "fixture-session",
      slot_id: "fixture-slot",
      card_revision: "9",
    })

    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  } finally {
    frames.close()
    child.kill()
    await child.exited
  }
})

function write(
  child: { stdin: { write(bytes: Uint8Array): unknown } },
  message: AgentWorkplaceMessage,
): void {
  child.stdin.write(encodeAgentWorkplaceFrame(message))
}

class FixtureFrameReader {
  private readonly decoder = new ContractFrameDecoder()
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly queued: AgentWorkplaceMessage[] = []

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  async next(): Promise<AgentWorkplaceMessage> {
    const queued = this.queued.shift()
    if (queued) return queued
    for (;;) {
      const next = await this.reader.read()
      if (next.done) {
        this.decoder.finish()
        throw new Error("fixture stdout ended before a complete frame")
      }
      const payloads = this.decoder.push(next.value)
      this.queued.push(...payloads.map((payload) => decodeAgentWorkplacePayload(payload)))
      const message = this.queued.shift()
      if (message) return message
    }
  }

  close(): void {
    this.reader.releaseLock()
  }
}
