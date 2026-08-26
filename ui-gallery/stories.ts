import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { BoxRenderable, type KeyEvent } from "@opentui/core"
import { AgentManifest } from "../src/agent-manifest.ts"
import type { AgentTransportFactory } from "../src/agent-transport.ts"
import type { AdeEventListener, AdeRecord } from "../src/ade-events.ts"
import { RAMP_FALLBACK } from "../src/host-palette.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { LaunchDialog } from "../src/launch-dialog.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import type { ProjectChoice } from "../src/projects.ts"
import { SessionList } from "../src/session-list.ts"
import { buildTree, type SessionEntry } from "../src/session-tree.ts"
import { Toast, type ToastTone } from "../src/toast.ts"
import { unusedSpaceBackground } from "../src/unused-space.ts"
import { GalleryAgentTransportFactory } from "./fakes.ts"
import type { UiStory, UiStoryContext } from "./story.ts"

const ROOT = resolve(import.meta.dir, "..")
// The checkout itself, whether it is `fmx` or a Worktree cut from it: an
// agent runs in a repository, and the project row is named for the
// repository either one belongs to rather than for the directory it sits in.
const GALLERY_CWD = ROOT
const NEVER = new AbortController().signal
const SESSION_ID = "909bc46b64721838"
const AGENT_SCREEN =
  "\x1b[2J\x1b[H\x1b[1;36mWorking on the UI gallery\x1b[0m\r\n\r\n" +
  "  ✓ Inventory visible components\r\n" +
  "  ✓ Exercise meaningful states\r\n" +
  "  ◐ Review the gallery in a terminal\r\n\r\n" +
  "\x1b[90mDeterministic state.\x1b[0m\r\n"

const PROJECTS: ProjectChoice[] = [
  { directory: "/Users/demo/code/fmx", display: "~/code/fmx", launches: 8 },
  { directory: "/Users/demo/code/agent-api", display: "~/code/agent-api", launches: 3 },
  { directory: "/Users/demo/code/agentbrain", display: "~/code/agentbrain", launches: 1 },
  { directory: "/Users/demo/code/fx", display: "~/code/fx", launches: 0 },
  { directory: "/Users/demo/code/zmax", display: "~/code/zmax", launches: 0 },
]

export const UI_STORIES: readonly UiStory[] = [
  {
    id: "multiplexer-empty",
    component: "Multiplexer",
    title: "No Agents",
    description: "An empty Home keeps the full work surface quiet and centers the one way to begin.",
    viewport: { cols: 86, rows: 24 },
    expectedText: ["prefix+l to launch agent"],
    interaction: "Use ctrl+b l to launch an Agent, or ctrl+b ? to open the key reference.",
    arrange: mountMultiplexer({ screen: AGENT_SCREEN }),
  },
  {
    id: "multiplexer-working",
    component: "Multiplexer",
    title: "Working Agent",
    description: "The everyday composition: Session list, active path, divider, and one working surface.",
    viewport: { cols: 86, rows: 24 },
    expectedText: ["Review UI", "Working on the UI gallery", "Review the gallery in a terminal"],
    interaction: "Use ctrl+b b to toggle the Tray and ctrl+b ? to inspect the active key map.",
    arrange: mountMultiplexer({
      screen: AGENT_SCREEN,
      afterMount: launchGalleryAgent,
    }),
  },
  {
    id: "multiplexer-larger-observer",
    component: "Multiplexer",
    title: "Larger observing Client",
    description: "The shared sizing-owner frame stays at top left while one flat host-relative field marks the observer's unused right and bottom space.",
    viewport: { cols: 86, rows: 24 },
    expectedText: ["Review UI", "Working on the UI gallery", "Review the gallery in a terminal"],
    arrange: mountMultiplexer({
      screen: AGENT_SCREEN,
      sizingOwnerFrame: { cols: 68, rows: 18 },
      afterMount: launchGalleryAgent,
    }),
  },
  {
    id: "session-list-status-atlas",
    component: "Session list",
    title: "Status atlas",
    description: "Every Agent state and each blocked attention glyph aligned in one branch.",
    viewport: { cols: 36, rows: 15 },
    expectedText: ["? waiting-for-answer", "↻ recovering-transport", "◐ implement-gallery", "✓ review-complete", "○ available", "· starting"],
    arrange(context) {
      mountSessionList(context, [
        entry({ agentId: 1, name: "needs-permission", state: "blocked", attention: "permission" }),
        entry({ agentId: 2, name: "waiting-for-answer", state: "blocked", attention: "question" }),
        entry({ agentId: 3, name: "recovering-transport", state: "blocked", attention: "route_recovery" }),
        entry({ agentId: 4, name: "implement-gallery", state: "working", active: true }),
        entry({ agentId: 5, name: "review-complete", state: "done" }),
        entry({ agentId: 6, name: "available", state: "idle" }),
        entry({ agentId: 7, name: "starting", state: "unknown" }),
      ])
    },
  },
  {
    id: "session-list-hierarchy",
    component: "Session list",
    title: "Projects, branches, and Subagents",
    description: "The active path, recursive Subagent rows, and an Agent whose checkout is gone in a second project.",
    viewport: { cols: 42, rows: 16 },
    expectedText: ["fmx", "feature/ui-gallery", "coordinate-the-review", "reviewer", "test-reader", "draft-release-notes"],
    arrange(context) {
      mountSessionList(context, [
        entry({
          agentId: 1,
          branch: "feature/ui-gallery",
          name: "coordinate-the-review",
          active: true,
          subagents: [
            {
              sessionId: "reviewer",
              label: "reviewer",
              state: "working",
              attention: null,
              children: [
                {
                  sessionId: "test-reader",
                  label: "test-reader",
                  state: "blocked",
                  attention: "question",
                  children: [],
                },
              ],
            },
          ],
        }),
        entry({ agentId: 2, project: "notes", branch: null, name: "draft-release-notes", state: "idle" }),
      ])
    },
  },
  {
    id: "session-list-narrow",
    component: "Session list",
    title: "Narrow tray",
    description: "Long project, branch, and Session name values truncate only at their right edge.",
    viewport: { cols: 20, rows: 8 },
    expectedText: ["agentbrain-worktree", "feature/componen…", "◐ gallery-with…"],
    arrange(context) {
      mountSessionList(
        context,
        [
          entry({
            project: "agentbrain-worktree",
            branch: "feature/component-gallery",
            name: "gallery-with-a-very-long-name",
            state: "working",
            active: true,
          }),
        ],
        20,
      )
    },
  },
  {
    id: "launch-dialog-default",
    component: "Launch dialog",
    title: "New launch",
    description: "The default launch dialog opens on its prompt field and the most-used project.",
    viewport: { cols: 86, rows: 26 },
    expectedText: ["launch", "what should the agent do?", "~/code/fmx", "worktree  no", "gpt-5.6-sol", "effort    high"],
    interaction: "Type a prompt; Tab moves through rows and Space opens the focused picker.",
    arrange(context) {
      mountLaunchDialog(context)
    },
  },
  {
    id: "launch-dialog-filled",
    component: "Launch dialog",
    title: "Multiline Worktree launch",
    description: "A prepared draft with a multiline Launch prompt, Worktree enabled, and an explicit launch level.",
    viewport: { cols: 86, rows: 26 },
    expectedText: ["Build the gallery", "Keep every state deterministic", "worktree  yes", "gpt-5.6-terra", "effort    xhigh"],
    interaction: "Edit the prompt or use Tab and Space to change any launch choice.",
    arrange(context) {
      const dialog = mountLaunchDialog(context, {
        prompt: "Build the gallery\nKeep every state deterministic",
        directory: PROJECTS[0]!.directory,
        model: "gpt-5.6-terra",
        effort: "xhigh",
      })
      dialog.setWorktreeAvailability(PROJECTS[0]!.directory, true)
      dialog.apply({ worktree: true })
    },
  },
  {
    id: "launch-dialog-unavailable-worktree",
    component: "Launch dialog",
    title: "Unavailable Worktree",
    description: "The Worktree row explains why it cannot be enabled for a Project with nothing committed yet.",
    viewport: { cols: 84, rows: 24 },
    expectedText: ["~/code/zmax", "unavailable — no commit to branch from"],
    interaction: "Move between rows to inspect which choices remain available.",
    arrange(context) {
      const dialog = mountLaunchDialog(context, { directory: PROJECTS[4]!.directory })
      dialog.setWorktreeAvailability(PROJECTS[4]!.directory, false)
    },
  },
  {
    id: "launch-dialog-project-picker",
    component: "Launch dialog",
    title: "Filtered project picker",
    description: "The project chooser filters by subsequence and keeps the best match highlighted.",
    viewport: { cols: 86, rows: 26 },
    expectedText: ["project", "> api", "~/code/agent-api"],
    interaction: "Type to filter, use arrows to move, Enter applies, and Escape cancels.",
    async arrange(context) {
      mountLaunchDialog(context)
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressKey(" ")
      await context.setup.mockInput.typeText("api")
    },
  },
  {
    id: "launch-dialog-model-picker",
    component: "Launch dialog",
    title: "Model catalog",
    description: "The model picker presents each local model with the efforts it supports.",
    viewport: { cols: 86, rows: 26 },
    expectedText: ["model", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "low/medium/high/xhigh"],
    interaction: "Use arrows to choose a model; Enter applies and Escape cancels.",
    arrange(context) {
      mountLaunchDialog(context)
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressKey(" ")
    },
  },
  ...(["neutral", "error"] as const).map((tone): UiStory => toastStory(tone)),
]

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    agentId: 1,
    project: "fmx",
    branch: "main",
    sessionId: SESSION_ID,
    name: null,
    state: "idle",
    attention: null,
    active: false,
    subagents: [],
    ...overrides,
  }
}

function mountSessionList(context: UiStoryContext, entries: SessionEntry[], width = context.setup.renderer.width): void {
  const list = new SessionList(context.setup.renderer, () => {})
  context.canvas.add(list.root)
  list.applyPalette(context.palette)
  list.render(buildTree(entries), width)
  context.defer(() => list.root.destroyRecursively())
}

function mountLaunchDialog(
  context: UiStoryContext,
  prefill: Parameters<LaunchDialog["show"]>[2] = {},
): LaunchDialog {
  let dialog: LaunchDialog
  dialog = new LaunchDialog(context.setup.renderer, {
    onLaunch: () => {},
    onClose: () => {},
    onProjectChange: (directory) => {
      dialog.setWorktreeAvailability(directory, directory !== PROJECTS[4]!.directory)
    },
  })
  const onKey = (key: KeyEvent) => {
    if (!dialog.handleKey(key)) return
    key.preventDefault()
    key.stopPropagation()
  }
  context.setup.renderer.keyInput.on("keypress", onKey)
  context.canvas.add(dialog.root)
  dialog.applyPalette(context.palette)
  dialog.show(PROJECTS, prefill.directory ?? PROJECTS[0]!.directory, prefill)
  context.defer(() => {
    context.setup.renderer.keyInput.off("keypress", onKey)
    dialog.root.destroyRecursively()
  })
  return dialog
}

function toastStory(tone: ToastTone): UiStory {
  const content = {
    neutral: "fmx / main / steady-moon started",
    error: "fmx / main / agent 5 exited / code 7",
  }[tone]
  const description = {
    neutral: "A lifecycle notice on a raised surface: the words carry the event, the dim hairline carries nothing.",
    error: "A failure is the one notice that spends a hue — the host's red, on the border alone.",
  }[tone]
  return {
    id: `toast-${tone}`,
    component: "Toast",
    title: `${tone[0]!.toUpperCase()}${tone.slice(1)} notice`,
    description,
    viewport: { cols: 62, rows: 12 },
    expectedText: [content],
    arrange(context) {
      mountToast(context, content, tone, tone === "neutral" ? ["steady-moon"] : [])
    },
  }
}

function mountToast(context: UiStoryContext, text: string, tone: ToastTone, italic: readonly string[] = []): void {
  const toast = new Toast(context.setup.renderer, { durationMs: 60_000 })
  context.canvas.add(toast.root)
  toast.applyPalette(context.palette)
  toast.show(text, tone, { italic })
  toast.layout()
  context.defer(() => toast.destroy())
}

type MultiplexerStoryOptions = {
  screen?: string
  sizingOwnerFrame?: { cols: number; rows: number }
  afterMount?: (
    multiplexer: Multiplexer,
    context: UiStoryContext,
  ) => void | Promise<void>
  transport?: AgentTransportFactory
}

function mountMultiplexer(options: MultiplexerStoryOptions = {}): (context: UiStoryContext) => Promise<void> {
  return async (context) => {
    if (options.sizingOwnerFrame) {
      context.canvas.backgroundColor = unusedSpaceBackground(context.palette)
      context.canvas.add(new BoxRenderable(context.setup.renderer, {
        id: "ui-gallery-sizing-owner-frame",
        position: "absolute",
        top: 0,
        left: 0,
        width: options.sizingOwnerFrame.cols,
        height: options.sizingOwnerFrame.rows,
        backgroundColor: context.palette?.defaultBackground ?? RAMP_FALLBACK.background,
      }))
    }
    const adeSocket = new GalleryAdeSocket()
    const multiplexer = new Multiplexer(context.setup.renderer, {
      fxPath: "fx",
      cwd: GALLERY_CWD,
      keybindings: resolveKeybindings().keybindings,
      manifest: AgentManifest.ephemeral("ui-gallery"),
      transport: options.transport ?? new GalleryAgentTransportFactory(options.screen ?? "", (launch) => {
        const sessionId = `1770000000000-000000000-gallery${launch.entry.displayId}`
        adeSocket.report({
          schemaVersion: 1,
          sequence: 1,
          event: "FxStarted",
          instanceId: launch.entry.agentId,
          context: { agentRole: "main", sessionId, parentSessionId: null, agentState: "idle", attentionKind: null },
          payload: {},
        })
        adeSocket.report({
          schemaVersion: 1,
          sequence: 2,
          event: "PromptQueued",
          instanceId: launch.entry.agentId,
          context: { agentRole: "main", sessionId, parentSessionId: null, agentState: "working", attentionKind: null },
          payload: {},
        })
        adeSocket.report({
          schemaVersion: 1,
          sequence: 3,
          event: "SessionMetadataChanged",
          instanceId: launch.entry.agentId,
          context: { agentRole: "main", sessionId, parentSessionId: null, agentState: "working", attentionKind: null },
          payload: { title: "Review UI" },
        })
      }),
      adeSocket,
      projectRoots: [],
      home: ROOT,
      toastDurationMs: 60_000,
    })
    if (options.sizingOwnerFrame) {
      const stage = context.setup.renderer.root.findDescendantById("fmx-stage")
      assert(stage instanceof BoxRenderable)
      stage.position = "absolute"
      stage.setPosition({ top: 0, left: 0 })
      stage.width = options.sizingOwnerFrame.cols
      stage.height = options.sizingOwnerFrame.rows
    }
    // The path index.ts takes: the first answer, or none, is what the startup
    // chrome is drawn from.
    multiplexer.lockStartupChrome(context.palette)
    multiplexer.unlockStartupChrome()
    context.defer(async () => {
      await multiplexer.shutdown()
    })
    await multiplexer.start()
    await options.afterMount?.(multiplexer, context)
  }
}

async function launchGalleryAgent(
  multiplexer: Multiplexer,
): Promise<void> {
  await multiplexer.control.handle(
    "launch",
    { directory: GALLERY_CWD, focus: true },
    NEVER,
  )
  await settlePromises()
}

class GalleryAdeSocket {
  readonly path = "/tmp/fmx-ui-gallery.ade.sock"
  private readonly listeners = new Set<AdeEventListener>()

  addEventListener(listener: AdeEventListener): void {
    this.listeners.add(listener)
  }

  report(record: AdeRecord): void {
    for (const listener of this.listeners) listener(record)
  }
}

async function settlePromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

assert.equal(new Set(UI_STORIES.map((story) => story.id)).size, UI_STORIES.length, "UI gallery story ids must be unique")
