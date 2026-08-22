import { closeSync, openSync } from "node:fs"
import { dlopen } from "bun:ffi"

const LOCK_EXCLUSIVE = 2
const LOCK_NONBLOCKING = 4
const LOCK_UNLOCK = 8

const FLOCK_SYMBOL = {
  flock: {
    args: ["i32", "i32"],
    returns: "i32",
  },
} as const

type Flock = (descriptor: number, operation: number) => number

let native: { call: Flock; library: object } | null | undefined

/**
 * Whether another process holds an exclusive flock on `path`. `null` means
 * the file or the native probe is unavailable, which callers must treat as an
 * unknown observation rather than evidence that the lock is free.
 */
export function exclusiveLockHeld(path: string): boolean | null {
  const nativeFlock = loadFlock()
  if (!nativeFlock) return null

  let descriptor: number
  try {
    descriptor = openSync(path, "r+")
  } catch {
    return null
  }

  try {
    if (nativeFlock(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) return true
    nativeFlock(descriptor, LOCK_UNLOCK)
    return false
  } catch {
    return null
  } finally {
    closeSync(descriptor)
  }
}

function loadFlock(): Flock | null {
  if (native !== undefined) return native?.call ?? null
  const library =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : null
  if (!library) {
    native = null
    return null
  }
  try {
    // The library stays open for the process lifetime: observers sample once a
    // second, and closing it would invalidate the function pointer.
    const opened = dlopen(library, FLOCK_SYMBOL)
    native = { call: opened.symbols.flock, library: opened }
  } catch {
    native = null
  }
  return native?.call ?? null
}
