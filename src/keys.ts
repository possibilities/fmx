export type CommandKey = {
  name: string
  sequence: string
  raw: string
  shift: boolean
  ctrl: boolean
  meta: boolean
  code?: string
  baseCode?: number
}

export function isPrefixKey(key: CommandKey): boolean {
  return key.ctrl && (key.name.toLowerCase() === "b" || key.baseCode === 98)
}

export function commandKeyName(key: CommandKey): string {
  if (key.name === "escape") return "escape"

  if (key.name.length === 1) {
    if (key.shift && /^[a-z]$/iu.test(key.name)) return key.name.toUpperCase()
    if (key.shift && key.name === "/") return "?"
    return key.name
  }

  if (key.sequence.length === 1) return key.sequence
  if (key.raw.length === 1) return key.raw
  return key.name
}

export function keyIdentity(key: CommandKey): string {
  return `${key.code ?? key.name}:${key.ctrl ? 1 : 0}:${key.meta ? 1 : 0}:${key.shift ? 1 : 0}`
}
