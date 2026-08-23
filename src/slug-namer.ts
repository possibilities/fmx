import { type FSWatcher, readFileSync, statSync, watch } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { SlugSettings } from "./config.ts"
import { ensureInferenceEffort, fxSettingsPath, inferenceWorkspace, readFxProvider } from "./fx-profile.ts"
import { type FirstPrompt, fxHomeDirectory, fxSessionDirectory, readFirstPrompt } from "./fx-sessions.ts"
import { claimNaming, readSlug, releaseNaming, slugDirectory, storeSlug } from "./slug-store.ts"
import { runSlugCompletion } from "./slug-runner.ts"
import { expandTilde } from "./projects.ts"
import { buildInstruction, excerptFrom } from "./slug-text.ts"

/**
 * Naming an agent, once, from the first thing its human asked for.
 *
 * fx reports a session id as soon as it has one, which is long before there is
 * anything to name — an agent can sit at a trust dialog, or simply wait, for
 * as long as its human is elsewhere. So an attempt watches the session's log
 * for a first prompt rather than demanding one, and gives up quietly when the
 * wait runs long; the next thing fx reports arms a fresh one. A conversation
 * nobody has started has no name, and that is the correct answer, not a fault.
 *
 * Everything here is best-effort by design. A slug is how a session reads in a
 * list and how it will be addressed on a command line — worth paying inference
 * for once, and never worth interrupting a session over.
 */

/**
 * A watch delivers fx's write; this is only the sweep behind it, for a
 * filesystem whose watches drop events. Long, because it should almost never
 * be what notices.
 */
const PROMPT_SWEEP_MS = 5_000
/**
 * How long an attempt waits between re-reads when it has no watch at all. fx
 * writes the prompt a second or several after it is submitted — usually two or
 * three, occasionally ten — so the early reads are quick and then ease off.
 */
const PROMPT_POLL_MS = [250, 250, 250, 250, 500, 500, 500, 1_000, 1_000] as const
const PROMPT_POLL_STEADY_MS = 2_000
/** A file mention is read into the excerpt up to this size; the excerpt's own
 * budget then bounds the whole. */
const MENTION_FILE_BYTES = 32 * 1024
/** How long one attempt watches before releasing its session back to the next
 * report. Long enough to cover a human finishing a thought, short enough that
 * an abandoned agent stops costing timers. */
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

/**
 * A prompt fmx already holds, because fmx is what typed it. An agent
 * launched with a prompt need not wait for fx to record what fmx dictated, so
 * naming starts the moment the session has an id — while fx is still reading
 * the prompt rather than seconds after it finishes.
 */
export type KnownPrompt = {
  text: string
  workspaceRoot: string
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
  note(sessionId: string, known: KnownPrompt | null = null): void {
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
    void this.run(sessionId, known).finally(() => {
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

  private async run(sessionId: string, known: KnownPrompt | null): Promise<void> {
    const sessionDirectory = fxSessionDirectory(sessionId, this.env)
    if (sessionDirectory === null) return

    const prompt =
      known === null ? await this.waitForPrompt(sessionDirectory) : { ...known }
    if (prompt === null || this.stopped) return

    if (!claimNaming(this.directory, sessionId)) {
      await this.waitForPeer(sessionId)
      return
    }
    try {
      this.prepare()
      const excerpt = excerptFrom(prompt.text, (mention) =>
        this.readMention(mention, prompt.workspaceRoot),
      )
      const slug = await runSlugCompletion(buildInstruction(excerpt), {
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

  /**
   * Wait for fx to record the prompt, woken by the write rather than looking
   * for it. A read still comes first, and a slow sweep still runs behind the
   * watch, so a missed event costs seconds rather than the name.
   */
  private async waitForPrompt(sessionDirectory: string): Promise<FirstPrompt | null> {
    const deadline = Date.now() + PROMPT_WINDOW_MS
    const changes = DirectoryChanges.open(sessionDirectory)
    try {
      for (let poll = 0; !this.stopped; poll += 1) {
        const prompt = await readFirstPrompt(sessionDirectory)
        if (prompt !== null) return prompt
        if (Date.now() >= deadline) return null
        if (changes === null) await this.wait(PROMPT_POLL_MS[poll] ?? PROMPT_POLL_STEADY_MS)
        else await Promise.race([changes.changed(), this.wait(PROMPT_SWEEP_MS)])
      }
      return null
    } finally {
      changes?.close()
    }
  }

  /**
   * What an @-mention points at, or null for anything that is not a real file
   * of text — a directory, a path that is not there, a binary. Only a mention
   * that resolves is read in; every other one stays in the prompt as it was
   * typed, because it is then just a word the human wrote. A relative mention
   * resolves against the session's own workspace, so it means what it meant
   * when it was typed.
   */
  private readMention(mention: string, workspaceRoot: string | null): string | null {
    const tilded = expandTilde(mention, fxHomeDirectory(this.env))
    const path = isAbsolute(tilded) ? tilded : workspaceRoot && join(workspaceRoot, tilded)
    if (!path) return null
    try {
      if (!statSync(path).isFile()) return null
      const content = readFileSync(path, "utf8").slice(0, MENTION_FILE_BYTES)
      return content.includes("\u0000") ? null : content
    } catch {
      return null
    }
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

/**
 * fx writing to a session's log, delivered rather than looked for.
 *
 * The directory is watched rather than the log inside it: fx creates the file
 * a moment after the directory, and a watch opened on a file that is not there
 * yet is no watch at all. The signal latches, so a write that lands between a
 * read and the wait after it is not missed and then waited out.
 */
class DirectoryChanges {
  static open(directory: string): DirectoryChanges | null {
    try {
      // Not persistent: a watch is never a reason for fmx to stay running.
      return new DirectoryChanges(watch(directory, { persistent: false }))
    } catch {
      // A directory that is not there yet, or a filesystem with no watches to
      // give. The caller's own reads are the whole answer then.
      return null
    }
  }

  private changed_ = false
  private waiting: (() => void) | null = null

  private constructor(private readonly watcher: FSWatcher) {
    watcher.on("change", () => this.notify())
    // A watch that fails mid-flight wakes the caller once so it reads again
    // and falls back to its own sweep.
    watcher.on("error", () => this.notify())
  }

  changed(): Promise<void> {
    if (this.changed_) {
      this.changed_ = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  close(): void {
    this.watcher.close()
  }

  private notify(): void {
    const waiting = this.waiting
    if (waiting === null) {
      this.changed_ = true
      return
    }
    this.waiting = null
    waiting()
  }
}
