import { type CliRenderer, CliRenderEvents, type Selection } from "@opentui/core"
import { VERSION } from "./cli.ts"
import { fxnkRamp, type FxnkThemeResolution } from "./host-palette.ts"
import type { LayoutNode } from "./protocol.ts"
import {
  ApiFailure,
  type EventData,
  type EventName,
  type Method,
  type Params,
  type Result,
} from "./protocol.ts"
import { Sessions, type SessionsOptions } from "./sessions.ts"
import { Stage } from "./stage.ts"

export type RuntimeOptions = {
  instanceId: string
  /** The public Instance name; `default` for the unnamed one. */
  instanceName: string
  socketPath: string
  theme: FxnkThemeResolution
  sessions: Omit<SessionsOptions, "renderer" | "theme" | "onExit" | "onChanged" | "onRoster">
  publish: (event: EventName, data: unknown) => void
  /** Diagnostics that belong on the Runtime's own terminal, not in a reply. */
  report?: (line: string) => void
}

/** What a fresh Instance draws until a caller applies a Layout of its own. */
export const EMPTY_LAYOUT: LayoutNode = { text: "no sessions" }

/**
 * One Instance: the Stage, the roster, and the API's handler. It owns no
 * socket and no process; `index.ts` binds the API to `handle` and holds the
 * Companion.
 */
export class Runtime {
  readonly sessions: Sessions
  readonly stage: Stage
  private theme: FxnkThemeResolution
  private shuttingDown = false
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly resizeHandler = () => this.onResize()
  private lastStage: { cols: number; rows: number }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: RuntimeOptions,
  ) {
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve
    })
    this.theme = options.theme
    this.sessions = new Sessions({
      ...options.sessions,
      renderer,
      theme: options.theme,
      onExit: (name, exit) => this.publish("session.exited", { name, ...exit }),
      onChanged: (name, title) => this.publish("session.changed", { name, title }),
      onRoster: () => this.refit(),
    })
    this.stage = new Stage({
      renderer,
      panes: this.sessions,
      theme: options.theme,
      onChanged: (cause) => this.publish("layout.changed", { layout: this.stage.view, cause }),
    })
    this.lastStage = this.stage.size
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
  }

  /** Adopt what the Companion still holds, then draw the first Layout. */
  async start(): Promise<void> {
    let adopted = 0
    try {
      const outcome = await this.sessions.adopt()
      adopted = outcome.adopted
      if (outcome.unresolved.length > 0) {
        this.options.report?.(
          `${outcome.unresolved.length} Companion session(s) unreachable; left for the next start`,
        )
      }
    } catch (error) {
      // A failed read must never be taken for an empty Companion: the
      // Sessions stay where they are for the next start.
      this.options.report?.(`could not adopt Sessions: ${message(error)}`)
    }
    const names = this.sessions.list().map((session) => session.name)
    const first = names[0]
    this.stage.apply(
      adopted > 0 && first ? { session: first } : EMPTY_LAYOUT,
      first ?? null,
    )
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise
  }

  setTheme(resolution: FxnkThemeResolution): void {
    if (this.shuttingDown) return
    this.theme = resolution
    this.renderer.setBackgroundColor(fxnkRamp(resolution.theme).background)
    this.stage.setTheme(resolution)
    this.sessions.setTheme(resolution)
    this.renderer.requestRender()
    this.publish("theme.changed", { theme: resolution.theme })
  }

  async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return this.donePromise
    this.shuttingDown = true
    try {
      this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
      this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler)
      this.renderer.clearSelection()
      // Let go, never end: every process is the Companion's, and the next
      // Runtime for this Instance finds them where this one left them.
      this.sessions.shutdown()
      this.stage.destroy()
    } finally {
      this.renderer.destroy()
      process.exitCode = exitCode
      this.resolveDone()
    }
  }

  /** The API's one way in. Params are already validated against the contract. */
  async handle(method: Method, params: unknown): Promise<unknown> {
    if (this.shuttingDown && method !== "instance.status") {
      throw new ApiFailure("conflict", "fmx is shutting down")
    }
    switch (method) {
      case "instance.status":
        return this.status()
      case "instance.stop": {
        this.publish("instance.stopping", {})
        // Answer first: the reply is written before anything is torn down.
        setTimeout(() => void this.stop(), 0)
        return {}
      }
      case "events.subscribe":
        return {}
      case "session.create":
        return this.sessions.create(params as Params<"session.create">)
      case "session.kill": {
        await this.sessions.kill((params as Params<"session.kill">).name)
        return {}
      }
      case "session.list":
        return { sessions: this.sessions.list() }
      case "session.capture":
        return this.sessions.capture((params as Params<"session.capture">).name)
      case "layout.apply": {
        const request = params as Params<"layout.apply">
        return this.stage.apply(request.root, request.focus === undefined ? undefined : request.focus, {
          revision: request.revision,
        })
      }
      case "layout.get":
        return this.stage.view
    }
  }

  private status(): Result<"instance.status"> {
    return {
      version: VERSION,
      pid: process.pid,
      name: this.options.instanceName,
      instance_id: this.options.instanceId,
      socket: this.options.socketPath,
      stage: this.stage.size,
      theme: this.theme.theme,
      sessions: this.sessions.list(),
      layout: this.stage.view,
    }
  }

  private async stop(): Promise<void> {
    await this.sessions.killAll().catch(() => {})
    await this.shutdown(0)
  }

  /** The roster changed: re-fit so a new Session's Pane fills without another apply. */
  private refit(): void {
    if (this.shuttingDown) return
    this.stage.refit()
  }

  /**
   * A Runtime resize applies the new physical size to OpenTUI synchronously
   * before this runs, so the fit here is against the size that is about to be
   * drawn. Every Pane hears its own size exactly once per resize.
   */
  private onResize(): void {
    if (this.shuttingDown) return
    const size = this.stage.size
    this.stage.refit("resize")
    if (size.cols !== this.lastStage.cols || size.rows !== this.lastStage.rows) {
      this.lastStage = size
      this.publish("stage.changed", size)
    }
  }

  private onSelection(selection: Selection): void {
    // A Pane keeps a gesture provisional until it has covered two cells.
    // Treat gestures that never cross that threshold as nothing at all.
    if (selection.isStart) {
      this.renderer.clearSelection()
      return
    }
    const text = selection.getSelectedText()
    if (!text) {
      this.renderer.clearSelection()
      return
    }
    if (this.renderer.copyToClipboardOSC52(text)) this.renderer.clearSelection()
  }

  private publish<E extends EventName>(event: E, data: EventData<E>): void {
    if (this.shuttingDown && event !== "instance.stopping") return
    this.options.publish(event, data)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
