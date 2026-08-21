export type CommandKey = {
  name: string
  code?: string
  baseCode?: number
}

export function keyIdentity(key: CommandKey): string {
  return key.code ?? (key.baseCode === undefined ? key.name.toLowerCase() : String(key.baseCode))
}
