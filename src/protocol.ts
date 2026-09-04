import { z } from "zod"

/**
 * The smolmux API, defined once. Every method below is validated by the Runtime,
 * typed for the client, printed by `smolmux api`, and described in `docs/api.md`,
 * all from this table.
 *
 * Wire: newline-delimited JSON over one duplex Unix socket. A client sends
 * `request` frames and receives `response` frames with the same id; after
 * `events.subscribe` it also receives `event` frames until it hangs up.
 */
export const PROTOCOL_VERSION = 1

export const SESSION_NAME = /^[a-z][a-z0-9_-]{0,31}$/u

const sessionName = z.string().regex(SESSION_NAME).describe("Session name: [a-z][a-z0-9_-]{0,31}")
const theme = z.enum(["dark", "light"])
/** `null` as its own `anyOf` branch, described, so JSON Schema readers keep it. */
const NONE = z.null().describe("null when there is none")
const labelToken = z.string().regex(/^[A-Za-z0-9_.-]+$/u)

export const stageSchema = z.object({
  cols: z.int().min(1),
  rows: z.int().min(1),
})
export type Stage = z.infer<typeof stageSchema>

export const sessionViewSchema = z.object({
  name: sessionName,
  pid: z.int().or(NONE).describe("The child's pid; null while unknown"),
  cwd: z.string(),
  argv: z.array(z.string()).or(NONE).describe("The argv it was created with; null when adopted from a previous Runtime"),
  created_at: z.number().describe("ms since the epoch"),
  title: z.string().describe("The last OSC 0/2 title the Session set; empty until it sets one"),
  cols: z.int().min(1),
  rows: z.int().min(1),
  shown: z.boolean().describe("Whether a Pane of the current Layout shows it"),
  state: z.enum(["live", "unreachable"]).describe("unreachable: its transport dropped and could not be reopened yet"),
  labels: z.record(labelToken, z.string()),
})
export type SessionView = z.infer<typeof sessionViewSchema>

const sizedLeaf = {
  size: z.int().min(1).optional().describe("Fixed columns in a row, rows in a column; omitted takes the remainder"),
  min: z.int().min(1).optional().describe("The smallest size this leaf may be squeezed to; default 1"),
}

export type LayoutNode =
  | { row: LayoutNode[]; size?: number; min?: number }
  | { column: LayoutNode[]; size?: number; min?: number }
  | { session: string; size?: number; min?: number }
  | { text: string; size?: number; min?: number }

/**
 * How deep a Layout may nest. A frame may carry far more nesting than a
 * recursive validator can walk, and a stack overflow there is a `RangeError`
 * rather than a validation failure — the caller would get no reply at all.
 * Nothing legible needs more than this.
 */
export const MAX_LAYOUT_DEPTH = 32

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ row: z.array(layoutNodeSchema).min(1), ...sizedLeaf }).strict(),
    z.object({ column: z.array(layoutNodeSchema).min(1), ...sizedLeaf }).strict(),
    z.object({ session: sessionName, ...sizedLeaf }).strict(),
    z.object({ text: z.string().max(200), ...sizedLeaf }).strict(),
  ]),
)

/**
 * How deep a request frame nests, measured on the raw line. `JSON.parse` is
 * itself recursive, so a frame deep enough to overflow it must be refused
 * before it is parsed, not after. Stops counting once past `limit`.
 */
export function frameNestingDepth(line: string, limit = MAX_LAYOUT_DEPTH): number {
  let depth = 0
  let deepest = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{" || character === "[") {
      depth += 1
      if (depth > deepest) {
        deepest = depth
        // A frame past the limit is refused whatever else it holds.
        if (deepest > limit) return deepest
      }
    } else if (character === "}" || character === "]") depth -= 1
  }
  return deepest
}

export const paneGeometrySchema = z.object({
  session: sessionName.or(NONE),
  text: z.string().or(NONE),
  x: z.int().min(0),
  y: z.int().min(0),
  cols: z.int().min(0),
  rows: z.int().min(0),
  focused: z.boolean(),
})
export type PaneGeometry = z.infer<typeof paneGeometrySchema>

export const layoutViewSchema = z.object({
  revision: z
    .int()
    .min(0)
    .describe("Increments whenever the tree changes, by an apply or a divider drag; pass it back to layout.apply to refuse a stale write"),
  root: layoutNodeSchema.or(NONE).describe("The applied tree with sizes as they stand after drags"),
  focus: sessionName.or(NONE).describe("The Session the keyboard goes to"),
  stage: stageSchema,
  panes: z.array(paneGeometrySchema).describe("Every Pane as fitted, in tree order; a squeezed-out Pane has 0 cols or rows"),
})
export type LayoutView = z.infer<typeof layoutViewSchema>

/**
 * The most history one capture may carry. A capture crosses the socket whole,
 * and a connection's unwritten output is capped, so the bound is part of the
 * contract rather than the caller's discretion.
 */
export const MAX_CAPTURE_SCROLLBACK = 10_000

export const captureSchema = z.object({
  name: sessionName,
  lines: z
    .array(z.string())
    .describe("One string per row, trailing blanks trimmed; history first when scrollback was asked for"),
  screen_start: z
    .int()
    .min(0)
    .describe("Index in `lines` where the visible screen begins; 0 when no history was asked for or none exists"),
  cols: z.int().min(1),
  rows: z.int().min(1),
  cursor: z.object({ x: z.int().min(0), y: z.int().min(0), visible: z.boolean() }).describe("Relative to the visible screen"),
  title: z.string(),
})
export type Capture = z.infer<typeof captureSchema>

export const instanceStatusSchema = z.object({
  version: z.string(),
  pid: z.int(),
  name: z.string().describe("The Instance name; `default` for the unnamed one"),
  instance_id: z.string(),
  socket: z.string().describe("This API socket's path"),
  stage: stageSchema,
  theme,
  sessions: z.array(sessionViewSchema),
  layout: layoutViewSchema,
})
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

const empty = z.object({}).strict()

export const METHODS = {
  "instance.status": {
    description: "The Runtime as it stands: version, stage size, theme, every Session, and the Layout.",
    params: empty,
    result: instanceStatusSchema,
  },
  "instance.stop": {
    description: "Respond, then kill every Session and end the Runtime. Every Client detaches.",
    params: empty,
    result: empty,
  },
  "events.subscribe": {
    description: "Receive event frames on this connection until it hangs up.",
    params: empty,
    result: empty,
  },
  "session.create": {
    description:
      "Start a command in a Companion-held PTY under a caller-chosen name. It runs whether or not a Pane shows it; put it in the Layout with layout.apply.",
    params: z
      .object({
        name: sessionName,
        argv: z.array(z.string().min(1)).min(1).describe("The executable first"),
        cwd: z.string().min(1).describe("An absolute directory"),
        env: z.record(z.string(), z.string()).optional().describe("Applied over smolmux's own environment with its private variables removed"),
        cols: z.int().min(1).max(65_535).optional().describe("The PTY size until a Pane sizes it; default 80"),
        rows: z.int().min(1).max(65_535).optional().describe("default 24"),
        labels: z.record(labelToken, labelToken).optional().describe("Caller labels kept on the Companion session; owner, instance, and session are smolmux's"),
      })
      .strict(),
    result: sessionViewSchema,
  },
  "session.kill": {
    description: "Ask the Companion to end a Session's process. Its removal arrives as session.exited.",
    params: z.object({ name: sessionName }).strict(),
    result: empty,
  },
  "session.list": {
    description: "Every Session in creation order.",
    params: empty,
    result: z.object({ sessions: z.array(sessionViewSchema) }),
  },
  "session.capture": {
    description:
      "A Session's screen as text, with its cursor and title, shown or not. `scrollback` asks for that many lines that have scrolled off the top, read from the Session's own emulator.",
    params: z
      .object({
        name: sessionName,
        scrollback: z
          .int()
          .min(0)
          .max(MAX_CAPTURE_SCROLLBACK)
          .optional()
          .describe(`Lines of history above the screen; at most ${MAX_CAPTURE_SCROLLBACK}, default none`),
      })
      .strict(),
    result: captureSchema,
  },
  "layout.apply": {
    description:
      "Replace the Layout with a tree of rows and columns whose leaves show Sessions or a line of text, and name the Session the keyboard goes to. Sessions in no Pane keep running at their last size.",
    params: z
      .object({
        root: layoutNodeSchema.or(NONE),
        focus: sessionName.or(NONE).optional().describe("Omitted keeps the focus if that Session is still shown"),
        revision: z
          .int()
          .min(0)
          .optional()
          .describe(
            "The revision this tree was built from. The apply is refused as a conflict when the Layout has moved since, so a human's divider drag is never silently clobbered by a stale read-modify-write.",
          ),
      })
      .strict(),
    result: layoutViewSchema,
  },
  "layout.get": {
    description: "The Layout as fitted to the stage right now.",
    params: empty,
    result: layoutViewSchema,
  },
} as const

export type Method = keyof typeof METHODS
export const METHOD_NAMES = Object.keys(METHODS) as Method[]
export type Params<M extends Method> = z.infer<(typeof METHODS)[M]["params"]>
export type Result<M extends Method> = z.infer<(typeof METHODS)[M]["result"]>

export const EVENTS = {
  "session.exited": {
    description: "A Session's process ended, or adoption found it gone. code and signal are null when the Companion could not read them.",
    data: z.object({
      name: sessionName,
      code: z.int().or(NONE),
      signal: z.int().or(NONE),
      reason: z.string(),
    }),
  },
  "session.changed": {
    description: "Output or a title change reached a Session's screen; debounced. Capture it to read it.",
    data: z.object({ name: sessionName, title: z.string() }),
  },
  "layout.changed": {
    description: "The fitted Layout changed: an apply, a divider drag, or a stage resize.",
    data: z.object({ layout: layoutViewSchema, cause: z.enum(["apply", "drag", "resize"]) }),
  },
  "stage.changed": {
    description: "The stage took a new size from its sizing owner.",
    data: stageSchema,
  },
  "theme.changed": {
    description: "The resolved fxnk theme changed.",
    data: z.object({ theme }),
  },
  "instance.stopping": {
    description: "instance.stop was accepted; the socket closes after this.",
    data: empty,
  },
} as const

export type EventName = keyof typeof EVENTS
export type EventData<E extends EventName> = z.infer<(typeof EVENTS)[E]["data"]>

export const ERROR_CODES = [
  "invalid_request",
  "unknown_method",
  "invalid_params",
  "not_found",
  "conflict",
  "companion_error",
  "internal",
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ApiFailure"
  }
}

export const requestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
})
export type RequestFrame = z.infer<typeof requestSchema>

export type ResponseFrame =
  | { v: typeof PROTOCOL_VERSION; type: "response"; id: string | null; ok: true; result: unknown }
  | { v: typeof PROTOCOL_VERSION; type: "response"; id: string | null; ok: false; error: { code: ErrorCode; message: string } }

export type EventFrame = {
  v: typeof PROTOCOL_VERSION
  type: "event"
  event: EventName
  data: unknown
}

export type Frame = RequestFrame | ResponseFrame | EventFrame

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`
}

export function successFrame(id: string | null, result: unknown): ResponseFrame {
  return { v: PROTOCOL_VERSION, type: "response", id, ok: true, result }
}

export function failureFrame(id: string | null, code: ErrorCode, message: string): ResponseFrame {
  return { v: PROTOCOL_VERSION, type: "response", id, ok: false, error: { code, message } }
}

export function eventFrame<E extends EventName>(event: E, data: EventData<E>): EventFrame {
  return { v: PROTOCOL_VERSION, type: "event", event, data }
}

export function isMethod(name: string): name is Method {
  return Object.hasOwn(METHODS, name)
}

/** The whole contract as one JSON document: what `smolmux api` prints. */
export function contractDocument(): Record<string, unknown> {
  const methods: Record<string, unknown> = {}
  for (const name of METHOD_NAMES) {
    const method = METHODS[name]
    methods[name] = {
      description: method.description,
      params: z.toJSONSchema(method.params),
      result: z.toJSONSchema(method.result),
    }
  }
  const events: Record<string, unknown> = {}
  for (const [name, event] of Object.entries(EVENTS)) {
    events[name] = { description: event.description, data: z.toJSONSchema(event.data) }
  }
  return {
    protocol: PROTOCOL_VERSION,
    frames: {
      request: { v: PROTOCOL_VERSION, type: "request", id: "string", method: "string", params: "object" },
      response: { v: PROTOCOL_VERSION, type: "response", id: "string|null", ok: "boolean", result: "any", error: { code: "string", message: "string" } },
      event: { v: PROTOCOL_VERSION, type: "event", event: "string", data: "object" },
    },
    methods,
    events,
    errors: ERROR_CODES,
  }
}
