import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { BoxRenderable, type KeyEvent } from "@opentui/core"
import { AgentManifest } from "../src/agent-manifest.ts"
import type { AgentTransportFactory } from "../src/agent-transport.ts"
import type { PanelDefinition } from "../src/config.ts"
import { DebugPanel } from "../src/debug-panel.ts"
import { FxTerminalRenderable } from "../src/fx-terminal.ts"
import { modalColors } from "../src/host-palette.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { LaunchDialog } from "../src/launch-dialog.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { PromptEditor } from "../src/prompt-editor.ts"
import type { ProjectChoice } from "../src/projects.ts"
import { SessionList } from "../src/session-list.ts"
import { buildTree, type SessionEntry } from "../src/session-tree.ts"
import { decodeFrame } from "../src/socket-frames.ts"
import { Toast, type ToastTone } from "../src/toast.ts"
import { ToolPanel } from "../src/tool-panel.ts"
import {
  GalleryAgentTransportFactory,
  GalleryPanelSessions,
  RejectingAgentTransportFactory,
} from "./fakes.ts"
import type { UiStory, UiStoryContext } from "./story.ts"

const ROOT = resolve(import.meta.dir, "..")
const NEVER = new AbortController().signal
const SESSION_ID = "909bc46b64721838"

const PROJECTS: ProjectChoice[] = [
  { directory: "/Users/demo/code/fmx", display: "~/code/fmx", launches: 8 },
  { directory: "/Users/demo/code/agent-api", display: "~/code/agent-api", launches: 3 },
  { directory: "/Users/demo/code/agentbrain", display: "~/code/agentbrain", launches: 1 },
  { directory: "/Users/demo/code/fx", display: "~/code/fx", launches: 0 },
  { directory: "/Users/demo/code/zmax", display: "~/code/zmax", launches: 0 },
]

const PANELS: PanelDefinition[] = [
  { id: "diff", label: "Diff", command: ["hunk", "diff", "--watch"], persistent: true },
  { id: "tests", label: "Tests", command: ["bun", "test", "--watch"], persistent: false },
]

export const UI_STORIES: readonly UiStory[] = [
  {
    id: "multiplexer-empty",
    component: "Multiplexer",
    title: "Empty state",
    description: "The chromeless shell before the Home has an Agent.",
    viewport: { cols: 80, rows: 24 },
    expectedText: ["prefix+c to create agent", "prefix+l to prompt agent"],
    arrange: mountMultiplexer(),
  },
  {
    id: "multiplexer-help",
    component: "Multiplexer",
    title: "Key reference",
    description: "The help modal over the empty shell, reached through the same control path as the key.",
    viewport: { cols: 80, rows: 24 },
    expectedText: ["keys", "new agent", "toggle tools", "ctrl+b"],
    arrange: mountMultiplexer(async (multiplexer) => {
      await multiplexer.control.handle("keys", { show: true }, NEVER)
    }),
  },
  {
    id: "multiplexer-start-error",
    component: "Multiplexer",
    title: "Agent start failure",
    description: "A failed direct start leaves no provisional Agent and explains the failure in a modal.",
    viewport: { cols: 88, rows: 24 },
    expectedText: ["error", "fx did not start", "ENOENT: fx executable was not found"],
    arrange: mountMultiplexer(
      async (_multiplexer, context) => {
        context.setup.mockInput.pressKey("b", { ctrl: true })
        context.setup.mockInput.pressKey("c")
        await context.setup.waitFor(() => context.setup.renderer.root.findDescendantById("fmx-modal")?.visible === true)
      },
      new RejectingAgentTransportFactory(),
    ),
  },
  {
    id: "agent-terminal-working",
    component: "Agent terminal",
    title: "Working Agent",
    description: "ANSI output, emphasis, and an established input cursor inside the embedded terminal.",
    viewport: { cols: 76, rows: 20 },
    expectedText: ["FMX AGENT 1", "Working", "Inspect the restore path", "Read 12 files"],
    arrange(context) {
      const terminal = new FxTerminalRenderable(context.setup.renderer, {
        id: "ui-gallery-agent-terminal",
        width: "100%",
        height: "100%",
        onData: () => {},
      })
      context.canvas.add(terminal)
      terminal.applyHostPalette(context.palette)
      terminal.write(
        "\x1b[2J\x1b[H\x1b[1;36mFMX AGENT 1\x1b[0m  \x1b[33mWorking\x1b[0m\r\n" +
          "\x1b[90m/Users/demo/code/fmx · silver-valley\x1b[0m\r\n\r\n" +
          "\x1b[1m› Inspect the restore path and cover the lost transport states\x1b[0m\r\n\r\n" +
          "  ✓ Read 12 files\r\n" +
          "  ✓ Reproduced stale cursor report\r\n" +
          "  ◐ Writing the regression test\r\n\r\n" +
          "\x1b[36m•\x1b[0m I found the reset ordering in src/multiplexer.ts.\r\n\r\n" +
          "› ",
      )
      terminal.focus()
      context.defer(() => terminal.destroy())
    },
  },
  {
    id: "agent-terminal-light",
    component: "Agent terminal",
    title: "Light host palette",
    description: "The same embedded emulator under a light terminal palette with status colors intact.",
    viewport: { cols: 62, rows: 14 },
    expectedText: ["Review complete", "3 files changed", "Ready for the next instruction"],
    arrange(context) {
      const terminal = new FxTerminalRenderable(context.setup.renderer, {
        id: "ui-gallery-agent-terminal-light",
        width: "100%",
        height: "100%",
        onData: () => {},
      })
      context.canvas.add(terminal)
      terminal.applyHostPalette(context.palette)
      terminal.write(
        "\x1b[2J\x1b[H\x1b[1;32m✓ Review complete\x1b[0m\r\n\r\n" +
          "  3 files changed, 118 insertions(+), 9 deletions(-)\r\n" +
          "  bun test: 214 pass\r\n" +
          "  bun run typecheck: pass\r\n\r\n" +
          "\x1b[34mReady for the next instruction.\x1b[0m\r\n",
      )
      context.defer(() => terminal.destroy())
    },
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
        entry({ agentId: 1, slug: "needs-permission", state: "blocked", attention: "permission" }),
        entry({ agentId: 2, slug: "waiting-for-answer", state: "blocked", attention: "question" }),
        entry({ agentId: 3, slug: "recovering-transport", state: "blocked", attention: "recovery" }),
        entry({ agentId: 4, slug: "implement-gallery", state: "working", active: true }),
        entry({ agentId: 5, slug: "review-complete", state: "done" }),
        entry({ agentId: 6, slug: "available", state: "idle" }),
        entry({ agentId: 7, slug: "starting", state: "unknown" }),
      ])
    },
  },
  {
    id: "session-list-hierarchy",
    component: "Session list",
    title: "Projects, branches, and Subagents",
    description: "The active path, recursive Subagent rows, and an untracked Agent in a second project.",
    viewport: { cols: 42, rows: 16 },
    expectedText: ["fmx", "feature/ui-gallery", "coordinate-the-review", "reviewer", "test-reader", "(untracked)"],
    arrange(context) {
      mountSessionList(context, [
        entry({
          agentId: 1,
          branch: "feature/ui-gallery",
          slug: "coordinate-the-review",
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
        entry({ agentId: 2, project: "notes", branch: null, slug: "draft-release-notes", state: "idle" }),
      ])
    },
  },
  {
    id: "session-list-narrow",
    component: "Session list",
    title: "Narrow tray",
    description: "Long project, branch, and Slug values truncate only at their right edge.",
    viewport: { cols: 20, rows: 8 },
    expectedText: ["agentbrain-worktree", "feature/componen…", "◐ gallery-with…"],
    arrange(context) {
      mountSessionList(
        context,
        [
          entry({
            project: "agentbrain-worktree",
            branch: "feature/component-gallery",
            slug: "gallery-with-a-very-long-name",
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
    description: "The default launch dialog opens on the Prompt editor and the most-used project.",
    viewport: { cols: 88, rows: 26 },
    expectedText: ["launch", "what should the agent do?", "~/code/fmx", "worktree  no", "gpt-5.6-sol", "effort    high"],
    arrange(context) {
      mountLaunchDialog(context)
    },
  },
  {
    id: "launch-dialog-filled",
    component: "Launch dialog",
    title: "Multiline Worktree launch",
    description: "A prepared draft with a multiline Launch prompt, Worktree enabled, and an explicit launch level.",
    viewport: { cols: 92, rows: 28 },
    expectedText: ["Build the gallery", "Keep every state deterministic", "worktree  yes", "gpt-5.6-terra", "effort    xhigh"],
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
    description: "The Worktree row explains why it cannot be enabled for an untracked project.",
    viewport: { cols: 84, rows: 24 },
    expectedText: ["~/code/zmax", "unavailable — not a repository"],
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
    viewport: { cols: 88, rows: 26 },
    expectedText: ["project", "> api", "~/code/agent-api"],
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
    viewport: { cols: 92, rows: 26 },
    expectedText: ["model", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "low/medium/high/xhigh"],
    arrange(context) {
      mountLaunchDialog(context)
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressTab()
      context.setup.mockInput.pressKey(" ")
    },
  },
  {
    id: "prompt-editor-placeholder",
    component: "Prompt editor",
    title: "Empty Prompt editor",
    description: "The real line editor at rest, including its instructional placeholder and cursor.",
    viewport: { cols: 58, rows: 10 },
    expectedText: ["what should the agent do?"],
    async arrange(context) {
      await mountPromptEditor(context, "")
    },
  },
  {
    id: "prompt-editor-wrapped",
    component: "Prompt editor",
    title: "Wrapped multiline Prompt",
    description: "A long Launch prompt wraps and grows while retaining the editor's capped viewport.",
    viewport: { cols: 54, rows: 14 },
    expectedText: ["Generate a gallery of every", "Include narrow widths, failures,", "light palettes."],
    async arrange(context) {
      await mountPromptEditor(
        context,
        "Generate a gallery of every visible component.\nInclude narrow widths, failures, and light palettes.",
        42,
      )
    },
  },
  {
    id: "tools-panel-no-agent",
    component: "Tools panel",
    title: "No active Agent",
    description: "Configured tools are visible, but the panel waits for an active Agent context.",
    viewport: { cols: 54, rows: 16 },
    expectedText: ["Diff", "Tests", "no active agent"],
    async arrange(context) {
      await mountToolPanel(context, new GalleryPanelSessions("ready"), false)
    },
  },
  {
    id: "tools-panel-loading",
    component: "Tools panel",
    title: "Tool loading",
    description: "The selected tool owns the body while its terminal transport is opening.",
    viewport: { cols: 54, rows: 16 },
    expectedText: ["Diff", "Tests", "loading Diff…"],
    async arrange(context) {
      await mountToolPanel(context, new GalleryPanelSessions("loading"))
    },
  },
  {
    id: "tools-panel-ready",
    component: "Tools panel",
    title: "Running test tool",
    description: "A live tool terminal beneath the link rail, with the selected link underlined.",
    viewport: { cols: 66, rows: 18 },
    expectedText: ["Diff", "Tests", "bun test v1.4.0", "214 pass", "Watching for changes"],
    async arrange(context) {
      await mountToolPanel(
        context,
        new GalleryPanelSessions(
          "ready",
          "\x1b[2J\x1b[H\x1b[1;34mbun test v1.4.0\x1b[0m\r\n\r\n  214 pass\r\n  0 fail\r\n\r\n\x1b[90mWatching for changes…\x1b[0m\r\n",
        ),
        true,
        "tests",
      )
    },
  },
  {
    id: "tools-panel-exited",
    component: "Tools panel",
    title: "Tool exited",
    description: "An ended tool explains its status and the exact action that restarts it.",
    viewport: { cols: 72, rows: 14 },
    expectedText: ["Diff exited (code 7); select its link to restart"],
    async arrange(context) {
      const sessions = new GalleryPanelSessions("ready", "diff output\r\n")
      await mountToolPanel(context, sessions)
      sessions.transports[0]?.exit(7)
    },
  },
  {
    id: "tools-panel-disconnected",
    component: "Tools panel",
    title: "Tool disconnected",
    description: "A lost transport is distinguished from a tool process ending and offers a retry.",
    viewport: { cols: 78, rows: 14 },
    expectedText: ["Diff disconnected: socket closed during restore; select its link to retry"],
    async arrange(context) {
      const sessions = new GalleryPanelSessions("ready", "diff output\r\n")
      await mountToolPanel(context, sessions)
      sessions.transports[0]?.lose("socket closed during restore")
    },
  },
  {
    id: "tools-panel-failed",
    component: "Tools panel",
    title: "Tool start failure",
    description: "A command failure remains inside the panel with a direct retry affordance.",
    viewport: { cols: 72, rows: 14 },
    expectedText: ["could not start Diff: command not found"],
    async arrange(context) {
      await mountToolPanel(context, new GalleryPanelSessions("failed"))
    },
  },
  {
    id: "debug-panel-empty",
    component: "Debug panel",
    title: "Empty frame tail",
    description: "The diagnostic surface identifies its Agent socket and keeps clear visible before frames arrive.",
    viewport: { cols: 52, rows: 14 },
    expectedText: ["agent socket · /tmp/fmx-ui-gallery.sock", "[clear]"],
    arrange(context) {
      mountDebugPanel(context)
    },
  },
  {
    id: "debug-panel-frames",
    component: "Debug panel",
    title: "Decoded and malformed frames",
    description: "Recent Agent-socket frames retain their headers, indented payloads, and malformed distinction.",
    viewport: { cols: 58, rows: 30 },
    expectedText: ["\"method\": \"pane.report_agent\"", "\"state\": \"working\"", "p_gallery pane.rename", "malformed", "{not-json"],
    arrange(context) {
      const panel = mountDebugPanel(context)
      panel.append(
        decodeFrame(
          1,
          Date.UTC(2026, 7, 23, 14, 5, 9, 120),
          '{"id":"1","method":"pane.report_agent","params":{"pane_id":"p_gallery","state":"working"}}',
        ),
      )
      panel.append(
        decodeFrame(
          2,
          Date.UTC(2026, 7, 23, 14, 5, 10, 440),
          '{"id":"2","method":"pane.rename","params":{"target":"p_gallery","label":"ui-gallery"}}',
        ),
      )
      panel.append(decodeFrame(3, Date.UTC(2026, 7, 23, 14, 5, 11), "{not-json"))
    },
  },
  ...(["success", "neutral", "error"] as const).map((tone): UiStory => toastStory(tone)),
  {
    id: "toast-narrow",
    component: "Toast",
    title: "Narrow lifecycle notice",
    description: "A long lifecycle notice truncates inside the safe horizontal inset.",
    viewport: { cols: 34, rows: 10 },
    expectedText: ["fmx / feature/ui-gallery / …"],
    arrange(context) {
      mountToast(context, "fmx / feature/ui-gallery / coordinate-the-review started", "success")
    },
  },
]

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    agentId: 1,
    project: "fmx",
    branch: "main",
    sessionId: SESSION_ID,
    slug: null,
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

async function mountPromptEditor(context: UiStoryContext, text: string, width = 46): Promise<void> {
  const container = new BoxRenderable(context.setup.renderer, {
    id: "ui-gallery-prompt-editor-frame",
    position: "absolute",
    left: 4,
    top: 3,
    width: width + 4,
    height: 10,
    padding: 1,
    border: true,
    borderStyle: "single",
    borderColor: modalColors(context.palette).accent,
    backgroundColor: modalColors(context.palette).background,
  })
  const editor = new PromptEditor(context.setup.renderer, { onChange: () => editor.measure(width) })
  container.add(editor.root)
  context.canvas.add(container)
  editor.applyPalette(modalColors(context.palette))
  if (text) editor.setText(text)
  editor.measure(width)
  editor.focus()
  await context.setup.renderOnce()
  editor.measure(width)
  editor.root.cursorOffset = 0
  context.defer(() => container.destroyRecursively())
}

async function mountToolPanel(
  context: UiStoryContext,
  sessions: GalleryPanelSessions,
  withContext = true,
  selected = "diff",
): Promise<ToolPanel> {
  const panel = new ToolPanel(context.setup.renderer, {
    definitions: PANELS,
    sessions,
    debugSocketPath: null,
    initialSelectedId: selected,
  })
  panel.setWidth(context.setup.renderer.width)
  context.canvas.add(panel.root)
  panel.applyPalette(context.palette, context.palette.defaultBackground === "#eef2f1" ? "light" : "dark")
  if (withContext) panel.setContext({ agentId: "gallery-agent", displayId: 1, cwd: "/Users/demo/code/fmx" })
  panel.setVisible(true)
  await settlePromises()
  context.defer(() => {
    panel.destroy()
    sessions.close()
    panel.root.destroyRecursively()
  })
  return panel
}

function mountDebugPanel(context: UiStoryContext): DebugPanel {
  const panel = new DebugPanel(context.setup.renderer, "/tmp/fmx-ui-gallery.sock")
  panel.setWidth(context.setup.renderer.width)
  panel.applyPalette(context.palette)
  context.canvas.add(panel.root)
  context.defer(() => panel.root.destroyRecursively())
  return panel
}

function toastStory(tone: ToastTone): UiStory {
  const content = {
    success: "fmx / main / agent 3 started",
    neutral: "fmx / main / steady-moon exited",
    error: "fmx / main / agent 5 exited / code 7",
  }[tone]
  return {
    id: `toast-${tone}`,
    component: "Toast",
    title: `${tone[0]!.toUpperCase()}${tone.slice(1)} notice`,
    description: `${tone} lifecycle tone using colors derived from the host palette.`,
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

function mountMultiplexer(
  afterMount: (multiplexer: Multiplexer, context: UiStoryContext) => void | Promise<void> = () => {},
  transport: AgentTransportFactory = new GalleryAgentTransportFactory(""),
): (context: UiStoryContext) => Promise<void> {
  return async (context) => {
    const multiplexer = new Multiplexer(context.setup.renderer, {
      fxPath: "fx",
      cwd: ROOT,
      keybindings: resolveKeybindings().keybindings,
      manifest: AgentManifest.ephemeral("ui-gallery"),
      transport,
      projectRoots: [],
      home: ROOT,
      toastDurationMs: 60_000,
    })
    multiplexer.setHostPalette(context.palette)
    context.defer(() => multiplexer.shutdown())
    await afterMount(multiplexer, context)
  }
}

async function settlePromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

assert.equal(new Set(UI_STORIES.map((story) => story.id)).size, UI_STORIES.length, "UI gallery story ids must be unique")
