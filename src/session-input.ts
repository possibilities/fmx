import { KeyEvent } from "@opentui/core"
import type { InputEvent } from "./protocol.ts"

/**
 * Semantic input, translated into what a Session's own emulator encodes.
 *
 * Nothing here writes an escape sequence. The emulator holds the modes each
 * Session turned on — Kitty or legacy keys, cursor-key mode, bracketed paste,
 * which mouse reports it asked for — so it is the only thing that can encode
 * for that Session, and a caller sends intent instead.
 */

/**
 * The physical key each named key stands for. Only these names are keys; every
 * other key is the character itself. The encoder maps the arrows, editing and
 * whitespace keys from their names on its own, but never the function keys, so
 * naming all of them here is what keeps `f1` from encoding as nothing.
 */
const NAMED_KEY_CODES: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  space: "Space",
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`f${index + 1}`, `F${index + 1}`])),
}

export type KeyInput = {
  key: string
  action?: "press" | "repeat" | "release"
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  super?: boolean
}

/** Absolute cell of a Pane's top-left corner, which mouse coordinates are relative to. */
export type PaneOrigin = { x: number; y: number }

export type MouseDelivery = {
  type: "down" | "up" | "move" | "drag" | "scroll"
  button: number
  x: number
  y: number
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean }
  scroll?: { direction: "up" | "down" | "left" | "right"; delta: number }
  isDragging?: boolean
}

const BUTTONS: Readonly<Record<string, number>> = { left: 0, middle: 1, right: 2 }

/** The physical code for a single character, where one exists. */
function codeForCharacter(character: string): string | undefined {
  if (/^[A-Za-z]$/u.test(character)) return `Key${character.toUpperCase()}`
  if (/^[0-9]$/u.test(character)) return `Digit${character}`
  return undefined
}

export function isNamedKey(key: string): boolean {
  return Object.hasOwn(NAMED_KEY_CODES, key.toLowerCase())
}

/**
 * One key press as the emulator's encoder wants it.
 *
 * `sequence` is what the encoder reads for the key's text, and `baseCode` is
 * the unshifted codepoint it reports — lowercased, so `A` and `a` agree on the
 * physical key they came from and only the modifier tells them apart.
 */
export function keyEventFor(input: KeyInput): KeyEvent {
  const named = NAMED_KEY_CODES[input.key.toLowerCase()]
  const characters = [...input.key]
  const isCharacter = named === undefined && characters.length === 1
  const character = characters[0] ?? ""

  // A named key has no text of its own; a character key's text is itself.
  const sequence = isCharacter ? character : input.key.toLowerCase() === "space" ? " " : ""
  const code = named ?? (isCharacter ? codeForCharacter(character) : undefined)
  const baseCode = isCharacter ? (character.toLowerCase().codePointAt(0) ?? 0) : undefined

  return new KeyEvent({
    name: named === undefined ? (isCharacter ? character : input.key.toLowerCase()) : input.key.toLowerCase(),
    ctrl: input.ctrl === true,
    // ParsedKey carries the Super modifier as `meta`; `option` is Alt.
    meta: input.super === true,
    shift: input.shift === true,
    option: input.alt === true,
    sequence,
    number: false,
    raw: sequence,
    eventType: input.action ?? "press",
    source: "raw",
    ...(code === undefined ? {} : { code }),
    ...(baseCode === undefined ? {} : { baseCode }),
  })
}

/** Typed text is one key press per character, which is what a program sees a human do. */
export function keyEventsForText(text: string): KeyEvent[] {
  return [...text].map((character) => keyEventFor({ key: character }))
}

export function mouseDeliveryFor(
  mouse: Extract<InputEvent, { mouse: unknown }>["mouse"],
  origin: PaneOrigin,
): MouseDelivery {
  const modifiers = { shift: mouse.shift === true, alt: mouse.alt === true, ctrl: mouse.ctrl === true }
  const x = origin.x + mouse.x
  const y = origin.y + mouse.y
  if (mouse.action === "scroll") {
    return {
      type: "scroll",
      button: 0,
      x,
      y,
      modifiers,
      scroll: mouse.scroll ?? { direction: "down", delta: 1 },
    }
  }
  const button = BUTTONS[mouse.button ?? "left"] ?? 0
  // Motion with a button held is a drag, and the encoder reports it as one
  // only when it is told a button is down.
  if (mouse.action === "drag") return { type: "drag", button, x, y, modifiers, isDragging: true }
  if (mouse.action === "move") return { type: "move", button, x, y, modifiers, isDragging: false }
  return { type: mouse.action, button, x, y, modifiers }
}
