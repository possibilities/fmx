import type { SlugSettings } from "./config.ts"
import { ensureInferenceEffort, fxSettingsPath, inferenceWorkspace, readFxProvider } from "./fx-profile.ts"
import { fxSessionDirectory, readFirstPrompt } from "./fx-sessions.ts"
import { claimNaming, readSlug, releaseNaming, slugDirectory, storeSlug } from "./slug-store.ts"
import { runSlugCompletion } from "./slug-runner.ts"
import { buildInstruction, excerptFrom } from "./slug-text.ts"

/**
 * Naming an instance, once, from the first thing its human asked for.
 *
 * fx reports a session id as soon as it has one, which is long before there is
 * anything to name — an instance can sit at a trust dialog, or simply wait, for
 * as long as its human is elsewhere. So an attempt watches the session's log
 * for a first prompt rather than demanding one, and gives up quietly when the
 * wait runs long; the next thing fx reports arms a fresh one. A conversation
 * nobody has started has no name, and that is the correct answer, not a fault.
 *
 * Everything here is best-effort by design. A slug is how a session reads in a
 * list and how it will be addressed on a command line — worth paying inference
 * for once, and never worth interrupting a session over.
 */

/** How often a watching attempt re-reads its session's log. */
const PROMPT_POLL_MS = 2_000
/** How long one attempt watches before releasing its session back to the next
 * report. Long enough to cover a human finishing a thought, short enough that
 * an abandoned instance stops costing timers. */
const PROMPT_WINDOW_MS = 10 * 60_000
/** After a failed attempt, how long before a report may arm another. */
const RETRY_COOLDOWN_MS = 60_000
/** A session another fmx claimed is its to name; this many polls of the store
 * is how long this one waits for the result before leaving it be. */
const PEER_POLL_MS = 3_000
const PEER_POLLS = 5

export type SlugNamerOptions = {
  fxPath: string
  settings: SlugSettings
  env?: NodeJS.ProcessEnv
  home?: string
  /** Called once per session, when its slug is known. */
  onSlug: (sessionId: string, slug: string) => void
}

type Attempt = {
  /** Set while an attempt owns this session; cleared when it ends. */
  running: boolean
  /** Earliest time a report may arm another attempt. */
  retryAt: number
}

export class SlugNamer {
  private readonly env: NodeJS.ProcessEnv
  private readonly directory: string
  private readonly workspace: string
  private readonly slugs = new Map<string, string>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly waits = new Map<ReturnType<typeof setTimeout>, () => void>()
  private prepared = false
  private model: string | null = null
  private stopped = false

  constructor(private readonly options: SlugNamerOptions) {
    this.env = options.env ?? process.env
    this.directory = slugDirectory(this.env, options.home)
    this.workspace = inferenceWorkspace(this.env, options.home)
  }

  /** The name this session is known by, or null while it has none. */
  slugFor(sessionId: string): string | null {
    return this.slugs.get(sessionId) ?? null
  }

  /**
   * fx has reported this session. Cheap and idempotent: called for every frame
   * a pane sends, it starts at most one attempt per session and answers a
   * session already named from memory.
   */
  note(sessionId: string): void {
    if (this.stopped || !this.options.settings.enabled) return
    if (this.slugs.has(sessionId)) return
    const attempt = this.attempts.get(sessionId)
    if (attempt && (attempt.running || attempt.retryAt > Date.now())) return

    const stored = readSlug(this.directory, sessionId)
    if (stored !== null) {
      this.adopt(sessionId, stored)
      return
    }

    this.attempts.set(sessionId, { running: true, retryAt: 0 })
    void this.run(sessionId).finally(() => {
      const current = this.attempts.get(sessionId)
      if (current) this.attempts.set(sessionId, { running: false, retryAt: Date.now() + RETRY_COOLDOWN_MS })
    })
  }

  /** End pending waits so a shutdown is not held up by a watching attempt.
   * Each is resolved rather than merely cleared, so the attempt around it runs
   * to its next `stopped` check and unwinds instead of leaking. */
  stop(): void {
    this.stopped = true
    for (const [timer, resolve] of this.waits) {
      clearTimeout(timer)
      resolve()
    }
    this.waits.clear()
  }

  private adopt(sessionId: string, slug: string): void {
    this.slugs.set(sessionId, slug)
    this.attempts.delete(sessionId)
    this.options.onSlug(sessionId, slug)
  }

  private async run(sessionId: string): Promise<void> {
    const sessionDirectory = fxSessionDirectory(sessionId, this.env)
    if (sessionDirectory === null) return

    const prompt = await this.waitForPrompt(sessionDirectory)
    if (prompt === null || this.stopped) return

    if (!claimNaming(this.directory, sessionId)) {
      await this.waitForPeer(sessionId)
      return
    }
    try {
      this.prepare()
      const slug = await runSlugCompletion(buildInstruction(excerptFrom(prompt)), {
        fxPath: this.options.fxPath,
        workspace: this.workspace,
        env: this.env,
        model: this.model,
        timeoutMs: this.options.settings.timeoutMs,
      })
      if (slug === null || this.stopped) return
      // Inference was paid for; the store is what keeps a second fmx, and this
      // one after a restart, from paying for the same session again.
      this.adopt(sessionId, storeSlug(this.directory, sessionId, slug) ?? slug)
    } finally {
      releaseNaming(this.directory, sessionId)
    }
  }

  private async waitForPrompt(sessionDirectory: string): Promise<string | null> {
    const deadline = Date.now() + PROMPT_WINDOW_MS
    while (!this.stopped) {
      const prompt = await readFirstPrompt(sessionDirectory)
      if (prompt !== null) return prompt
      if (Date.now() >= deadline) return null
      await this.wait(PROMPT_POLL_MS)
    }
    return null
  }

  /** Another fmx holds the claim; watch for what it stores. */
  private async waitForPeer(sessionId: string): Promise<void> {
    for (let poll = 0; poll < PEER_POLLS && !this.stopped; poll += 1) {
      await this.wait(PEER_POLL_MS)
      const stored = readSlug(this.directory, sessionId)
      if (stored !== null) {
        this.adopt(sessionId, stored)
        return
      }
    }
  }

  /**
   * The provider decides the model, and the effort has to be in fx's settings
   * before the first completion runs — both are read once, on the way into
   * naming rather than at startup, so an fmx that never names a session never
   * reads or writes another program's configuration.
   */
  private prepare(): void {
    if (this.prepared) return
    this.prepared = true
    const settingsPath = fxSettingsPath(this.env)
    if (this.options.settings.manageEffort) {
      ensureInferenceEffort(settingsPath, this.workspace, this.options.settings.effort)
    }
    this.model = this.options.settings.models[readFxProvider(settingsPath)] ?? null
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waits.delete(timer)
        resolve()
      }, milliseconds)
      this.waits.set(timer, resolve)
    })
  }
}
