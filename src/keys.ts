export type CommandKey = {
  name: string
  sequence: string
  raw: string
  shift: boolean
  ctrl: boolean
  meta: boolean
  option?: boolean
  super?: boolean
  hyper?: boolean
  code?: string
  baseCode?: number
}

export function isPrefixKey(key: CommandKey): boolean {
  return (
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper &&
    (key.name.toLowerCase() === "b" || key.baseCode === 98)
  )
}

export function hasCommandModifier(key: CommandKey): boolean {
  return key.ctrl || key.meta || Boolean(key.option || key.super || key.hyper)
}

export function isSuspendKey(key: CommandKey): boolean {
  return (
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper &&
    (key.name.toLowerCase() === "z" || key.baseCode === 122)
  )
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
  return key.code ?? (key.baseCode === undefined ? key.name.toLowerCase() : String(key.baseCode))
}
