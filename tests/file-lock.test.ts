import { expect, test } from "bun:test"
import { closeSync, openSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dlopen } from "bun:ffi"
import { exclusiveLockHeld } from "../src/file-lock.ts"

const LOCK_EXCLUSIVE = 2
const LOCK_NONBLOCKING = 4
const LOCK_UNLOCK = 8

test("distinguishes a free lock, a held lock, and an absent file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-lock-"))
  const path = join(directory, "session.lock")
  await writeFile(path, "", { mode: 0o600 })

  expect(exclusiveLockHeld(path)).toBe(false)
  expect(exclusiveLockHeld(join(directory, "absent.lock"))).toBeNull()

  const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
  const native = dlopen(library, {
    flock: { args: ["i32", "i32"], returns: "i32" },
  } as const)
  const descriptor = openSync(path, "r+")
  try {
    expect(native.symbols.flock(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING)).toBe(0)
    expect(exclusiveLockHeld(path)).toBe(true)
  } finally {
    native.symbols.flock(descriptor, LOCK_UNLOCK)
    closeSync(descriptor)
    native.close()
  }
  expect(exclusiveLockHeld(path)).toBe(false)
})
