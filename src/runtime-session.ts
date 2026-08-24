import { stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { OWNER_LABEL } from "./agent-reconcile.ts"
import { CompanionCreateError, type CompanionCommand, type SessionEntry } from "./zmx-command.ts"

export const RUNTIME_PROCESS_ENV_VAR = "FMX_RUNTIME_PROCESS"
export const RUNTIME_BOOTSTRAP_ENV_VAR = "FMX_RUNTIME_BOOTSTRAP_PATH"

const RUNTIME_SESSION_PREFIX = "fmxr"
const RUNTIME_SESSION_KIND = "runtime"
const BOOTSTRAP_TIMEOUT_MS = 10_000
const BOOTSTRAP_POLL_MS = 20

export type RuntimeSessionIdentity = {
  name: string
  labels: Record<string, string>
  bootstrapPath: string
}

export type RuntimeSession = {
  socketPath: string
  bootstrapPath: string
}

export type RuntimeSessionRequest = {
  homeId: string
  cwd: string
  command: string[]
  env: Record<string, string>
}

/** One deterministic Companion session is the shared fmx Runtime for a Home. */
export function runtimeSessionIdentity(homeId: string, companionDirectory: string): RuntimeSessionIdentity {
  const name = `${RUNTIME_SESSION_PREFIX}-${homeId}`
  return {
    name,
    labels: { owner: OWNER_LABEL, home: homeId, kind: RUNTIME_SESSION_KIND },
    bootstrapPath: join(companionDirectory, `.${name}.bootstrap`),
  }
}

/**
 * Join the Home's live Runtime or create it. The Companion arbitrates a
 * simultaneous first launch: an AlreadyExists loser inspects and joins the
 * winner, while an unrelated session at the stable name is never touched.
 */
export async function ensureRuntimeSession(
  companion: CompanionCommand,
  request: RuntimeSessionRequest,
): Promise<RuntimeSession> {
  const identity = runtimeSessionIdentity(request.homeId, companion.directory)
  let session = await companion.settle(identity.name)
  if (session.state === "live") return attachedRuntime(identity, session)
  if (session.state === "exited") {
    assertOwnedRuntime(identity, session)
    await companion.forget(identity.name)
  } else if (session.state === "refused" || session.state === "unreachable") {
    throw new Error(`fmx Runtime is ${session.state}${session.detail ? ` (${session.detail})` : ""}`)
  }

  // A marker from an earlier Runtime must never let a new child start before
  // its first terminal has actually attached.
  await unlink(identity.bootstrapPath).catch(() => {})
  const runtimeEnvironment = {
    ...request.env,
    [RUNTIME_PROCESS_ENV_VAR]: "1",
    [RUNTIME_BOOTSTRAP_ENV_VAR]: identity.bootstrapPath,
  }

  try {
    const created = await companion.create({
      name: identity.name,
      command: request.command,
      cwd: request.cwd,
      env: runtimeEnvironment,
      labels: identity.labels,
      exitOnLastClient: true,
    })
    return { socketPath: created.socketPath, bootstrapPath: identity.bootstrapPath }
  } catch (error) {
    // A racing creator owns the same deterministic Runtime. A timeout also
    // may have crossed exec even though its acknowledgement did not arrive.
    if (!(error instanceof CompanionCreateError) || (error.code !== "AlreadyExists" && !error.sessionMayExist)) {
      throw error
    }
    session = await companion.settle(identity.name)
    if (session.state !== "live") throw error
    return attachedRuntime(identity, session)
  }
}

function attachedRuntime(identity: RuntimeSessionIdentity, session: SessionEntry): RuntimeSession {
  assertOwnedRuntime(identity, session)
  if (!session.socketPath) throw new Error(`fmx Runtime ${identity.name} has no terminal socket`)
  return { socketPath: session.socketPath, bootstrapPath: identity.bootstrapPath }
}

function assertOwnedRuntime(identity: RuntimeSessionIdentity, session: SessionEntry): void {
  if (
    session.name !== identity.name ||
    !Object.entries(identity.labels).every(([key, value]) => session.labels[key] === value)
  ) {
    throw new Error(`Companion session ${identity.name} does not belong to this fmx Runtime`)
  }
}

/**
 * The Runtime waits here before constructing OpenTUI. The first Client writes
 * the marker only after its terminal attach reaches Ready, so palette and
 * capability queries have a real host ready to answer. A failed first attach
 * cannot leave a headless Runtime behind forever.
 */
export async function waitForRuntimeBootstrap(
  path: string,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
  pollMs = BOOTSTRAP_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isFile()) {
        await unlink(path).catch(() => {})
        return
      }
    } catch {
      // The first Client has not completed its attach yet.
    }
    await Bun.sleep(pollMs)
  }
  throw new Error("the first terminal Client did not attach to the fmx Runtime")
}

/** argv for this same fmx, whether it is a Bun source checkout or one binary. */
export function currentRuntimeCommand(
  executable: string = process.execPath,
  main: string = Bun.main,
): string[] {
  return main.startsWith("/$bunfs/") ? [executable] : [executable, main]
}

export function isRuntimeProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUNTIME_PROCESS_ENV_VAR] === "1"
}
