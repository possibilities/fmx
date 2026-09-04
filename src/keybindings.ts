import type { KeyEvent } from "@opentui/core"

type BindingConfig = string | string[]

type KeysConfig = {
  prefix: string
  detach: BindingConfig
}

/**
 * fmx claims exactly one chord. The prefix is a latch the thin Client holds
 * until the next key proves it is not Detach; every other key, the prefix
 * included, reaches the focused Session unchanged.
 */
const DEFAULT_KEYS_CONFIG: Readonly<KeysConfig> = {
  prefix: "ctrl+b",
  detach: "prefix+d",
}

const KEY_CONFIG_FIELDS = ["prefix", "detach"] as const

export type KeyActionName = Exclude<(typeof KEY_CONFIG_FIELDS)[number], "prefix">
type BindingTrigger = "direct" | "prefix"

type KeyModifiers = {
  ctrl: boolean
  alt: boolean
  shift: boolean
  super: boolean
  hyper: boolean
}

type KeyCombo = KeyModifiers & {
  key: string
}

export type ResolvedBinding = {
  trigger: BindingTrigger
  combo: KeyCombo
  label: string
}

export type Keybindings = {
  prefix: KeyCombo
  prefixLabel: string
  detach: ResolvedBinding[]
}

type ResolvedKeybindings = {
  keybindings: Keybindings
  diagnostics: string[]
}

type BindingSource = "default" | "user"
type RegisteredBinding = { field: string; source: BindingSource }

/** Every action a key can run. */
const ACTION_FIELDS = KEY_CONFIG_FIELDS.filter((field): field is KeyActionName => field !== "prefix")
const EMPTY_MODIFIERS: KeyModifiers = {
  ctrl: false,
  alt: false,
  shift: false,
  super: false,
  hyper: false,
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  " ": "space",
  space: "space",
  enter: "enter",
  return: "enter",
  esc: "escape",
  escape: "escape",
  tab: "tab",
  backtab: "backtab",
  backspace: "backspace",
  bs: "backspace",
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  minus: "-",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  quote: "'",
  double_quote: '"',
  "double-quote": '"',
  semicolon: ";",
  colon: ":",
  percent: "%",
  ampersand: "&",
  backtick: "`",
  plus: "+",
}

const SHIFTED_CHARACTERS: Readonly<Record<string, string>> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
}

export function resolveKeybindings(rawKeys?: unknown): ResolvedKeybindings {
  const diagnostics: string[] = []
  const configured = isRecord(rawKeys) ? rawKeys : {}
  if (rawKeys !== undefined && !isRecord(rawKeys)) {
    diagnostics.push("invalid keys config: [keys] must be a table; using defaults")
  }

  const knownFields = new Set<string>(KEY_CONFIG_FIELDS)
  for (const field of Object.keys(configured)) {
    if (!knownFields.has(field)) diagnostics.push(`unknown config key keys.${field}; ignoring key`)
  }

  const prefixIsUserConfigured = Object.hasOwn(configured, "prefix")
  const configuredPrefix = configured.prefix
  let prefix = parseKeyCombo(DEFAULT_KEYS_CONFIG.prefix)!
  if (prefixIsUserConfigured) {
    if (typeof configuredPrefix === "string") {
      const parsedPrefix = parseKeyCombo(configuredPrefix)
      if (parsedPrefix) prefix = parsedPrefix
      else diagnostics.push(`invalid keybinding: keys.prefix = ${JSON.stringify(configuredPrefix)}; using fallback`)
    } else {
      diagnostics.push(`invalid keybinding: keys.prefix must be a string; using fallback`)
    }
  }

  const keybindings: Keybindings = {
    prefix,
    prefixLabel: formatKeyCombo(prefix),
    detach: [],
  }

  const registry = new Map<string, RegisteredBinding>()
  registry.set(registryKey("direct", prefix), {
    field: "keys.prefix",
    source: prefixIsUserConfigured ? "user" : "default",
  })

  for (const source of ["user", "default"] as const) {
    for (const field of ACTION_FIELDS) {
      const userConfigured = Object.hasOwn(configured, field)
      if ((source === "user") !== userConfigured) continue
      const rawValue = userConfigured ? configured[field] : DEFAULT_KEYS_CONFIG[field]
      const values = bindingValues(rawValue, `keys.${field}`, diagnostics)
      if (!values) continue

      keybindings[field] = parseActionBindings(
        field,
        values,
        source,
        prefix,
        prefixIsUserConfigured,
        registry,
        diagnostics,
      )
    }
  }

  return { keybindings, diagnostics }
}

export function keyMatchesCombo(key: KeyEvent, expected: KeyCombo): boolean {
  const actualModifiers = eventModifiers(key)
  const candidates = eventKeyCandidates(key)

  if (modifiersEqual(actualModifiers, expected) && candidates.has(expected.key)) return true

  if (actualModifiers.shift && !expected.shift) {
    const withoutShift = { ...actualModifiers, shift: false }
    if (modifiersEqual(withoutShift, expected) && shiftedEventKeyCandidates(key).has(expected.key)) return true
  }

  if (!actualModifiers.shift && expected.shift) {
    const shiftedModifiers = { ...actualModifiers, shift: true }
    const rawCharacter = singleCharacter(key.sequence) ?? singleCharacter(key.raw)
    if (
      rawCharacter &&
      /^[A-Z]$/u.test(rawCharacter) &&
      modifiersEqual(shiftedModifiers, expected) &&
      rawCharacter.toLowerCase() === expected.key
    ) {
      return true
    }
    const shiftedSymbol = SHIFTED_CHARACTERS[expected.key]
    if (shiftedSymbol && modifiersEqual(shiftedModifiers, expected) && candidates.has(shiftedSymbol)) return true
  }

  return false
}

function parseActionBindings(
  field: KeyActionName,
  values: string[],
  source: BindingSource,
  prefix: KeyCombo,
  prefixIsUserConfigured: boolean,
  registry: Map<string, RegisteredBinding>,
  diagnostics: string[],
): ResolvedBinding[] {
  const bindings: ResolvedBinding[] = []
  for (const raw of values) {
    if (!raw.trim()) continue
    const parsed = parseBinding(raw)
    if (!parsed) {
      diagnostics.push(`invalid keybinding: keys.${field} = ${JSON.stringify(raw)}; disabling binding`)
      continue
    }
    if (registerBinding(field, parsed, source, prefix, prefixIsUserConfigured, registry, diagnostics)) {
      bindings.push(parsed)
    }
  }
  return bindings
}

function registerBinding(
  field: KeyActionName,
  binding: ResolvedBinding,
  source: BindingSource,
  prefix: KeyCombo,
  prefixIsUserConfigured: boolean,
  registry: Map<string, RegisteredBinding>,
  diagnostics: string[],
): boolean {
  const qualifiedField = `keys.${field}`
  if (binding.trigger === "prefix" && combosEqual(binding.combo, prefix)) {
    if (source === "default" && prefixIsUserConfigured) return false
    diagnostics.push(
      `reserved keybinding: ${qualifiedField} = ${JSON.stringify(binding.label)} uses keys.prefix as the prefix-mode key; this binding is disabled`,
    )
    return false
  }

  const key = registryKey(binding.trigger, binding.combo)
  const existing = registry.get(key)
  if (existing) {
    if (source === "default" && existing.source === "user") return false
    diagnostics.push(`${binding.label}: kept ${existing.field}, disabled ${qualifiedField}`)
    return false
  }

  if (binding.trigger === "direct" && isUnmodifiedPrintable(binding.combo)) {
    diagnostics.push(
      `unsafe direct keybinding: ${qualifiedField} = ${JSON.stringify(binding.label)} would intercept typing; use ${JSON.stringify(`prefix+${binding.label}`)} to require the prefix; disabling binding`,
    )
    return false
  }

  registry.set(key, { field: qualifiedField, source })
  return true
}

function parseBinding(raw: string): ResolvedBinding | null {
  const trimmed = raw.trim()
  const prefix = trimmed.startsWith("prefix+")
  const body = prefix ? trimmed.slice("prefix+".length) : trimmed
  const combo = parseKeyCombo(body)
  if (!combo) return null
  const label = formatKeyCombo(combo)
  return {
    trigger: prefix ? "prefix" : "direct",
    combo,
    label: prefix ? `prefix+${label}` : label,
  }
}

export function parseKeyCombo(raw: string): KeyCombo | null {
  const modifiers = { ...EMPTY_MODIFIERS }
  let keyToken: string | null = null
  for (const part of raw.split("+")) {
    const token = part.trim()
    if (!token) return null
    if (applyModifier(modifiers, token)) continue
    if (keyToken !== null) return null
    keyToken = token
  }
  if (keyToken === null) return null

  const lower = keyToken.toLowerCase()
  let key = KEY_ALIASES[lower]
  if (!key) {
    if ([...keyToken].length === 1) {
      if (/^[A-Z]$/u.test(keyToken)) modifiers.shift = true
      key = /^[A-Z]$/u.test(keyToken) ? keyToken.toLowerCase() : keyToken
    } else if (/^f\d+$/u.test(lower)) {
      const functionNumber = Number(lower.slice(1))
      if (!Number.isInteger(functionNumber) || functionNumber < 1 || functionNumber > 255) return null
      key = lower
    } else {
      return null
    }
  }

  if (key === "tab" && modifiers.shift) {
    modifiers.shift = false
    key = "backtab"
  }
  return { ...modifiers, key }
}

function applyModifier(modifiers: KeyModifiers, raw: string): boolean {
  switch (raw.toLowerCase()) {
    case "ctrl":
    case "control":
      modifiers.ctrl = true
      return true
    case "alt":
    case "option":
    case "meta":
      modifiers.alt = true
      return true
    case "shift":
      modifiers.shift = true
      return true
    case "cmd":
    case "command":
    case "super":
      modifiers.super = true
      return true
    case "hyper":
      modifiers.hyper = true
      return true
    default:
      return false
  }
}

function formatKeyCombo(combo: KeyCombo): string {
  const parts: string[] = []
  if (combo.ctrl) parts.push("ctrl")
  if (combo.alt) parts.push("alt")
  if (combo.shift) parts.push("shift")
  if (combo.super) parts.push(process.platform === "darwin" ? "cmd" : "super")
  if (combo.hyper) parts.push("hyper")
  parts.push(formatKeyName(combo.key))
  return parts.join("+")
}

function formatKeyName(key: string): string {
  if (key === "space") return "space"
  if (key === "escape") return "esc"
  if (key === "backtab") return "shift+tab"
  return key
}

function eventModifiers(key: KeyEvent): KeyModifiers {
  const shiftedTab = key.shift && key.name.toLowerCase() === "tab"
  return {
    ctrl: key.ctrl,
    alt: key.meta || key.option,
    shift: shiftedTab ? false : key.shift,
    super: Boolean(key.super),
    hyper: Boolean(key.hyper),
  }
}

function eventKeyCandidates(key: KeyEvent): Set<string> {
  const candidates = new Set<string>()
  if (key.shift && key.name.toLowerCase() === "tab") candidates.add("backtab")
  addEventKeyCandidate(candidates, key.name)
  const sequenceCharacter = singleCharacter(key.sequence)
  if (sequenceCharacter && !isControlCharacter(sequenceCharacter)) addEventKeyCandidate(candidates, sequenceCharacter)
  const rawCharacter = singleCharacter(key.raw)
  if (rawCharacter && !isControlCharacter(rawCharacter)) addEventKeyCandidate(candidates, rawCharacter)
  if (key.baseCode !== undefined) {
    const baseCharacter = String.fromCodePoint(key.baseCode)
    if (!isControlCharacter(baseCharacter)) addEventKeyCandidate(candidates, baseCharacter)
  }
  return candidates
}

function shiftedEventKeyCandidates(key: KeyEvent): Set<string> {
  const candidates = eventKeyCandidates(key)
  for (const candidate of [...candidates]) {
    const shifted = SHIFTED_CHARACTERS[candidate]
    if (shifted) candidates.add(shifted)
    if (/^[a-z]$/u.test(candidate)) candidates.add(candidate.toUpperCase())
  }
  return candidates
}

function addEventKeyCandidate(candidates: Set<string>, raw: string): void {
  const lower = raw.toLowerCase()
  const alias = KEY_ALIASES[lower]
  if (alias) {
    candidates.add(alias)
    return
  }
  if (/^[A-Z]$/u.test(raw)) candidates.add(raw.toLowerCase())
  else candidates.add(raw)
}

function singleCharacter(value: string): string | null {
  const characters = [...value]
  return characters.length === 1 ? characters[0]! : null
}

function isControlCharacter(character: string): boolean {
  const codepoint = character.codePointAt(0)!
  return codepoint < 0x20 || codepoint === 0x7f
}

function bindingValues(raw: unknown, field: string, diagnostics: string[]): string[] | null {
  if (typeof raw === "string") return [raw]
  if (Array.isArray(raw) && raw.every((value) => typeof value === "string")) return raw
  diagnostics.push(`invalid keybinding: ${field} must be a string or array of strings; disabling binding`)
  return null
}

function registryKey(trigger: BindingTrigger, combo: KeyCombo): string {
  return `${trigger}:${comboKey(combo)}`
}

function comboKey(combo: KeyCombo): string {
  return [combo.ctrl, combo.alt, combo.shift, combo.super, combo.hyper, combo.key].join(":")
}

function combosEqual(left: KeyCombo, right: KeyCombo): boolean {
  return left.key === right.key && modifiersEqual(left, right)
}

function modifiersEqual(left: KeyModifiers, right: KeyModifiers): boolean {
  return (
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.super === right.super &&
    left.hyper === right.hyper
  )
}

function isUnmodifiedPrintable(combo: KeyCombo): boolean {
  return (
    !combo.ctrl &&
    !combo.alt &&
    !combo.shift &&
    !combo.super &&
    !combo.hyper &&
    (combo.key === "space" || [...combo.key].length === 1)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

