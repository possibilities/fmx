import { appendFileSync } from "node:fs"
import { userInfo } from "node:os"
import { privateRootDirectory } from "./zmx-environment.ts"

/**
 * Where a Runtime says what went wrong. Never stderr: a headless Runtime's
 * stderr is the Companion PTY that OpenTUI is drawing into, so a diagnostic
 * written there lands across the screen of every attached Client. The file is
 * mode 0600 inside the private directory, beside the Instance's socket.
 */
export function instanceLogPathFor(instanceId: string, uid: number = userInfo().uid): string {
  return `${privateRootDirectory(uid)}/${instanceId}.log`
}

export function instanceLogger(path: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    } catch {
      // A diagnostic that cannot be written is not worth taking the Runtime
      // down for, and it must never reach the screen.
    }
  }
}
