import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { BoxRenderable } from "@opentui/core"
import { AgentManifest } from "../src/agent-manifest.ts"
import type { AgentTransportFactory } from "../src/agent-transport.ts"
import type { AdeEventListener, AdeRecord } from "../src/ade-events.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { SessionList } from "../src/session-list.ts"
import { buildTree, type SessionEntry } from "../src/session-tree.ts"
import { unusedSpaceBackground } from "../src/unused-space.ts"
import { GalleryAgentTransportFactory } from "./fakes.ts"
import type { UiStory, UiStoryContext } from "./story.ts"

const ROOT = resolve(import.meta.dir, "..")
// The checkout itself, whether it is `fmx` or a Worktree cut from it: an
// agent runs in a repository, and the project row is named for the
// repository either one belongs to rather than for the directory it sits in.
const GALLERY_CWD = ROOT
const SESSION_ID = "909bc46b64721838"
const AGENT_SCREEN =
  "\x1b[2J\x1b[H\x1b[1;36mWorking on the UI gallery\x1b[0m\r\n\r\n" +
  "  ✓ Inventory visible components\r\n" +
  "  ✓ Exercise meaningful states\r\n" +
  "  ◐ Review the gallery in a terminal\r\n\r\n" +
  "\x1b[90mDeterministic state.\x1b[0m\r\n"

export const UI_STORIES: readonly UiStory[] = [
  {
    id: "multiplexer-empty",
    component: "Multiplexer",
    title: "No Agents",
    description: "An empty Home keeps the full work surface quiet.",
    viewport: { cols: 86, rows: 24 },
    expectedText: ["no agents"],
    interaction: "Use ctrl+b ? to open the key reference.",
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
      afterMount: startGalleryAgent,
    }),
  },
  {
    id: "multiplexer-larger-client",
    component: "Multiplexer",
    title: "Larger observing Client",
    description: "The shared sizing-owner frame stays at top left while one flat fxnk theme step marks the larger Client's unused right and bottom space.",
    viewport: { cols: 86, rows: 24 },
    expectedText: ["Review UI", "Working on the UI gallery", "Review the gallery in a terminal"],
    arrange: mountMultiplexer({
      screen: AGENT_SCREEN,
      sizingOwnerFrame: { cols: 68, rows: 18 },
      afterMount: startGalleryAgent,
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
  list.applyTheme(context.themeMode)
  list.render(buildTree(entries), width)
  context.defer(() => list.root.destroyRecursively())
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
      context.canvas.backgroundColor = unusedSpaceBackground(context.themeMode)
      context.canvas.add(new BoxRenderable(context.setup.renderer, {
        id: "ui-gallery-sizing-owner-frame",
        position: "absolute",
        top: 0,
        left: 0,
        width: options.sizingOwnerFrame.cols,
        height: options.sizingOwnerFrame.rows,
        backgroundColor: context.palette?.defaultBackground ?? "#1c1c1c",
      }))
    }
    const adeSocket = new GalleryAdeSocket()
    const multiplexer = new Multiplexer(context.setup.renderer, {
      fxPath: "fx",
      cwd: GALLERY_CWD,
      keybindings: resolveKeybindings().keybindings,
      manifest: AgentManifest.ephemeral("ui-gallery"),
      transport: options.transport ?? new GalleryAgentTransportFactory(options.screen ?? "", (request) => {
        const sessionId = `1770000000000-000000000-gallery${request.entry.displayId}`
        adeSocket.report({
          schemaVersion: 1,
          sequence: 1,
          event: "FxStarted",
          instanceId: request.entry.agentId,
          context: {
            agentRole: "main",
            workspaceRoot: null,
            sessionId,
            parentSessionId: null,
            subagentId: null,
            turnId: null,
            agentState: "idle",
            attentionKind: null,
          },
          payload: {},
        })
        adeSocket.report({
          schemaVersion: 1,
          sequence: 2,
          event: "PromptQueued",
          instanceId: request.entry.agentId,
          context: {
            agentRole: "main",
            workspaceRoot: null,
            sessionId,
            parentSessionId: null,
            subagentId: null,
            turnId: null,
            agentState: "working",
            attentionKind: null,
          },
          payload: {},
        })
        adeSocket.report({
          schemaVersion: 1,
          sequence: 3,
          event: "SessionMetadataChanged",
          instanceId: request.entry.agentId,
          context: {
            agentRole: "main",
            workspaceRoot: null,
            sessionId,
            parentSessionId: null,
            subagentId: null,
            turnId: null,
            agentState: "working",
            attentionKind: null,
          },
          payload: { title: "Review UI" },
        })
      }),
      adeSocket,
      home: ROOT,
      initialTheme: {
        theme: context.themeMode,
        background: context.palette?.defaultBackground ?? null,
        source: context.palette ? "osc11" : "default",
        explicit: false,
      },
    })
    if (options.sizingOwnerFrame) {
      const stage = context.setup.renderer.root.findDescendantById("fmx-stage")
      assert(stage instanceof BoxRenderable)
      stage.position = "absolute"
      stage.setPosition({ top: 0, left: 0 })
      stage.width = options.sizingOwnerFrame.cols
      stage.height = options.sizingOwnerFrame.rows
    }
    context.defer(async () => {
      await multiplexer.shutdown()
    })
    await multiplexer.start()
    await options.afterMount?.(multiplexer, context)
  }
}

async function startGalleryAgent(
  multiplexer: Multiplexer,
): Promise<void> {
  await multiplexer.startAgent({ directory: GALLERY_CWD, focus: true })
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
