import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  RUNTIME_EXTENSION_CAPABILITIES,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
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
      readOne(child.stdout),
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
    child.kill()
    await child.exited
  }
})

async function readOne(stream: ReadableStream<Uint8Array>) {
  const decoder = new ContractFrameDecoder()
  const reader = stream.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        decoder.finish()
        throw new Error("fixture stdout ended before a complete frame")
      }
      const [payload] = decoder.push(next.value)
      if (payload) return decodeAgentWorkplacePayload(payload)
    }
  } finally {
    reader.releaseLock()
  }
}
