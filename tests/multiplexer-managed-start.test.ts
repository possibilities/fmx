import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import {
  AgentManifest,
  type AgentIdentity,
  type CreateParams,
  type ManifestEntry,
} from "../src/agent-manifest.ts"
import type {
  AgentStart,
  AgentTransport,
  AgentTransportFactory,
  TerminalSize,
  TransportHandlers,
} from "../src/agent-transport.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer, type ManagedAgentClaim } from "../src/multiplexer.ts"

const AGENT_ID = "a".repeat(32)
const CWD = process.cwd()
const FX = "/managed/fx"

class ProbeTransport implements AgentTransport {
  handlers: TransportHandlers | null = null
  resizes: TerminalSize[] = []
  detached = false

  bind(handlers: TransportHandlers): void {
    this.handlers = handlers
  }

  write(_bytes: Uint8Array): void {}

  resize(size: TerminalSize): void {
    this.resizes.push({ ...size })
  }

  detach(): void {
    this.detached = true
  }
}

class ManagedTransportFactory implements AgentTransportFactory {
  readonly starts: AgentStart[] = []
  readonly attaches: ManifestEntry[] = []
  readonly processes = new Set<string>()
  readonly transports: ProbeTransport[] = []

  async start(request: AgentStart): Promise<AgentTransport> {
    this.starts.push(copyStart(request))
    if (this.processes.has(request.entry.agentId) && !request.recoverExisting) {
      throw new Error("duplicate process start")
    }
    this.processes.add(request.entry.agentId)
    const transport = new ProbeTransport()
    this.transports.push(transport)
    return transport
  }

  async attach(entry: ManifestEntry): Promise<AgentTransport> {
    this.attaches.push(structuredClone(entry))
    if (!this.processes.has(entry.agentId)) throw new Error("process is absent")
    const transport = new ProbeTransport()
    this.transports.push(transport)
    return transport
  }
}

function copyStart(request: AgentStart): AgentStart {
  return {
    ...request,
    entry: structuredClone(request.entry),
    command: [...request.command],
    env: { ...request.env },
    size: { ...request.size },
  }
}

function claim(agentId = AGENT_ID): ManagedAgentClaim {
  return {
    agentId,
    cwd: CWD,
    fxPath: FX,
    fxArgs: ["--managed"],
    createdAt: 1234,
    workControl: {
      socketPath: `/tmp/fmx-managed.${agentId}.fx`,
      instanceId: agentId,
      token: "ab".repeat(32),
    },
  }
}

async function harness(manifest = AgentManifest.ephemeral("managed-test")) {
  const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const transport = new ManagedTransportFactory()
  const multiplexer = new Multiplexer(setup.renderer, {
    manifest,
    transport,
    fxPath: FX,
    cwd: CWD,
    keybindings: resolveKeybindings().keybindings,
  })
  await multiplexer.start()
  return { setup, manifest, transport, multiplexer }
}

test("projects a predetermined managed identity, then durably starts and adopts its exact invocation", async () => {
  const h = await harness()
  try {
    const projected = await h.multiplexer.projectManagedAgent(claim())
    expect(projected).toMatchObject({
      agentId: AGENT_ID,
      paneId: `p_${AGENT_ID}`,
      zmxName: `fmx-${AGENT_ID}`,
      displayId: 1,
      phase: "creating",
      workControl: claim().workControl,
    })
    expect(h.transport.starts).toHaveLength(0)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()

    const result = await h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: { EXACT: "invocation" },
    })

    expect(result).toEqual({ sessionName: `fmx-${AGENT_ID}`, paneId: `p_${AGENT_ID}` })
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.starts[0]).toMatchObject({
      entry: { agentId: AGENT_ID, phase: "creating" },
      command: [FX, "--managed"],
      cwd: CWD,
      env: { EXACT: "invocation" },
      recoverExisting: true,
    })
    expect(h.transport.transports[0]?.handlers).not.toBeNull()
    expect(h.transport.transports[0]?.resizes).toHaveLength(1)
  } finally {
    await h.multiplexer.shutdown()
  }
})

test("exact projection and start replay reuse one row and one process", async () => {
  const h = await harness()
  try {
    const first = await h.multiplexer.projectManagedAgent(claim())
    const replay = await h.multiplexer.projectManagedAgent(claim())
    expect(replay).toEqual(first)
    expect(h.manifest.entries).toHaveLength(1)
    expect(h.setup.renderer.root.findDescendantById("fx-2")).toBeUndefined()

    const invocation = { command: [FX, "--managed"], cwd: CWD, env: { A: "1" } }
    const [started, joined] = await Promise.all([
      h.multiplexer.startManagedAgent(AGENT_ID, invocation),
      h.multiplexer.startManagedAgent(AGENT_ID, { ...invocation, env: { A: "1" } }),
    ])
    expect(joined).toEqual(started)
    expect(await h.multiplexer.startManagedAgent(AGENT_ID, invocation)).toEqual(started)
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.attaches).toHaveLength(0)
    expect(h.transport.processes.size).toBe(1)
  } finally {
    await h.multiplexer.shutdown()
  }
})

test("Manifest write failures keep one recoverable projection and never duplicate Fx", async () => {
  const manifest = AgentManifest.ephemeral("managed-write-failure")
  const originalEnsureClaim = manifest.ensureClaim.bind(manifest)
  let failClaimWrite = true
  manifest.ensureClaim = (params: CreateParams & { identity: AgentIdentity }) => {
    const pending = originalEnsureClaim(params)
    if (!failClaimWrite) return pending
    failClaimWrite = false
    return {
      result: pending.result,
      saved: pending.saved.then(() => Promise.reject(new Error("claim write failed"))),
    }
  }
  const h = await harness(manifest)
  try {
    await expect(h.multiplexer.projectManagedAgent(claim())).rejects.toThrow("claim write failed")
    expect(h.manifest.entries).toHaveLength(1)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    await h.multiplexer.projectManagedAgent(claim())
    expect(h.manifest.entries).toHaveLength(1)

    const originalMarkRunning = manifest.markRunning.bind(manifest)
    let failRunningWrite = true
    manifest.markRunning = async (agentId: string) => {
      const running = await originalMarkRunning(agentId)
      if (failRunningWrite) {
        failRunningWrite = false
        throw new Error("running write failed")
      }
      return running
    }
    const invocation = { command: [FX, "--managed"], cwd: CWD, env: {} }
    await expect(h.multiplexer.startManagedAgent(AGENT_ID, invocation)).rejects.toThrow("running write failed")
    expect(h.transport.transports[0]?.handlers).toBeNull()
    expect(h.transport.transports[0]?.detached).toBe(true)

    await h.multiplexer.startManagedAgent(AGENT_ID, invocation)
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.attaches).toHaveLength(1)
    expect(h.transport.processes.size).toBe(1)
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")
    expect(h.transport.transports[1]?.handlers).not.toBeNull()
  } finally {
    await h.multiplexer.shutdown()
  }
})
