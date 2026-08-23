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

export type HeldLock = { release: () => void }

/**
 * Take an exclusive flock on `path`, creating it if needed, and hold it until
 * released: the fd stays open for as long as the lock matters. `null` when
 * another process holds it; `undefined` when the native probe is unavailable
 * and nothing can be said either way.
 */
export function acquireExclusiveLock(path: string): HeldLock | null | undefined {
  const nativeFlock = loadFlock()
  if (!nativeFlock) return undefined
  let descriptor: number
  try {
    descriptor = openSync(path, "a+")
  } catch {
    return undefined
  }
  try {
    if (nativeFlock(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) {
      closeSync(descriptor)
      return null
    }
  } catch {
    closeSync(descriptor)
    return undefined
  }
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      try {
        nativeFlock(descriptor, LOCK_UNLOCK)
      } finally {
        closeSync(descriptor)
      }
    },
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
