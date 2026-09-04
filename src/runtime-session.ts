import { CompanionCreateError, type CompanionCommand, type SessionEntry } from "./zmx-command.ts"
import { OWNER_LABEL, RUNTIME_KIND, runtimeLabels, runtimeSessionName } from "./session-identity.ts"
import { listenerAnswers } from "./unix-socket.ts"

/** Set on the Runtime child so a human reading `ps` can tell it apart. */
export const RUNTIME_PROCESS_ENV_VAR = "SMOLMUX_RUNTIME_PROCESS"

/** How long `smolmux start` waits for a new Runtime to answer its API socket. */
export const RUNTIME_READY_TIMEOUT_MS = 15_000
const RUNTIME_READY_INTERVAL_MS = 25

export type RuntimeSession = {
  /** The Companion terminal socket a Client attaches to. */
  socketPath: string
  /** False when an already-live Runtime was joined. */
  created: boolean
}

export type RuntimeSessionRequest = {
  instanceId: string
  cwd: string
  command: string[]
  env: Record<string, string>
}

/**
 * Join the Instance's live Runtime or create it. The Companion arbitrates a
 * simultaneous first launch: an AlreadyExists loser inspects and joins the
 * winner, while an unrelated session at the stable name is never touched.
 *
 * The Runtime is headless: it renders, binds its API socket, and holds its
 * Sessions whether or not a terminal Client is attached, and it ends only on
 * `instance.stop`, a signal, or a crash.
 */
export async function ensureRuntimeSession(
  companion: CompanionCommand,
  request: RuntimeSessionRequest,
): Promise<RuntimeSession> {
  const name = runtimeSessionName(request.instanceId)
  const labels = runtimeLabels(request.instanceId)
  let session = await companion.settle(name)
  if (session.state === "live") return { socketPath: attachedRuntime(name, labels, session), created: false }
  if (session.state === "exited") {
    assertOwnedRuntime(name, labels, session)
    await companion.forget(name)
  } else if (session.state === "refused" || session.state === "unreachable") {
    throw new Error(`smolmux Runtime is ${session.state}${session.detail ? ` (${session.detail})` : ""}`)
  }

  const environment = { ...request.env, [RUNTIME_PROCESS_ENV_VAR]: "1" }
  try {
    const created = await companion.create({
      name,
      command: request.command,
      cwd: request.cwd,
      env: environment,
      labels,
    })
    return { socketPath: created.socketPath, created: true }
  } catch (error) {
    // A racing creator owns the same deterministic Runtime. A timeout also
    // may have crossed exec even though its acknowledgement did not arrive.
    if (!(error instanceof CompanionCreateError) || (error.code !== "AlreadyExists" && !error.sessionMayExist)) {
      throw error
    }
    session = await companion.settle(name)
    if (session.state !== "live") throw error
    return { socketPath: attachedRuntime(name, labels, session), created: false }
  }
}

/** The live Runtime for an Instance, or null when none answers. */
export async function findRuntimeSession(
  companion: CompanionCommand,
  instanceId: string,
): Promise<SessionEntry | null> {
  const session = await companion.inspect(runtimeSessionName(instanceId))
  return session.state === "live" ? session : null
}

/** Wait for a Runtime to answer its API socket, so `start` returns something usable. */
export async function waitForRuntimeApi(
  path: string,
  timeoutMs = RUNTIME_READY_TIMEOUT_MS,
  intervalMs = RUNTIME_READY_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await listenerAnswers(path)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function attachedRuntime(name: string, labels: Record<string, string>, session: SessionEntry): string {
  assertOwnedRuntime(name, labels, session)
  if (!session.socketPath) throw new Error(`smolmux Runtime ${name} has no terminal socket`)
  return session.socketPath
}

function assertOwnedRuntime(name: string, labels: Record<string, string>, session: SessionEntry): void {
  const owned =
    session.name === name &&
    session.labels.owner === OWNER_LABEL &&
    session.labels.instance === labels.instance &&
    session.labels.kind === RUNTIME_KIND
  if (!owned) throw new Error(`Companion session ${name} does not belong to this smolmux Runtime`)
}

/** argv for this same smolmux, whether it is a Bun source checkout or one binary. */
export type RuntimeCommandOptions = {
  executable?: string
  main?: string
  /** Omitted or `default` leaves the default Runtime argv unchanged. */
  name?: string | null
}

export function currentRuntimeCommand(options: RuntimeCommandOptions = {}): string[] {
  const executable = options.executable ?? process.execPath
  const main = options.main ?? Bun.main
  const command = main.startsWith("/$bunfs/") ? [executable] : [executable, main]
  command.push("runtime")
  if (options.name && options.name !== "default") command.push("--name", options.name)
  return command
}
