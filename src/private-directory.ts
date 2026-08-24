import { mkdir, stat } from "node:fs/promises"
import { userInfo } from "node:os"

/**
 * Create and verify a directory only this user may read or write.
 *
 * Every path fmx owns under `/tmp` is predictable and anyone could have made
 * it first: a directory another user owns, or one others can write to, could
 * hold sockets that answer as our sessions, or code fmx hands to a tool to
 * run. Each level is created private and checked every start; nothing is
 * created into one that fails.
 */
export async function ensurePrivateDirectories(
  directories: readonly string[],
  label: string,
  uid: number = userInfo().uid,
): Promise<void> {
  for (const path of directories) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error(`${label} directory ${path} is not a directory`)
    if (info.uid !== uid) {
      throw new Error(`${label} directory ${path} is owned by uid ${info.uid}, not ${uid}; refusing to use it`)
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `${label} directory ${path} is readable or writable by others (mode ${(info.mode & 0o777).toString(8)}); refusing to use it (chmod 700 ${path})`,
      )
    }
  }
}
