#!/usr/bin/env bun

import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { CompanionCommand, type SessionEntry } from "../src/zmx-command.ts"

const SETTLE_MS = 15_000

async function main(): Promise<void> {
  const { directory, zmxPath, summary } = parseArguments(Bun.argv.slice(2))
  if (![directory, zmxPath, summary].every(isAbsolute)) {
    throw new Error("cleanup paths must be absolute")
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const physicalDirectory = await realpath(directory)
  const binary = await realpath(zmxPath)
  const binaryFacts = await lstat(binary)
  if (!binaryFacts.isFile() || (binaryFacts.mode & 0o111) === 0) {
    throw new Error("--zmx-path must be an executable regular file")
  }

  const companion = new CompanionCommand(physicalDirectory, process.env, binary)
  const initial = await companion.list()
  const observedPids = new Set(initial.flatMap(({ pid }) => pid === null ? [] : [pid]))
  const names = new Set(initial.map(({ name }) => name))

  for (const entry of initial) await reapEntry(companion, entry)

  const deadline = Date.now() + SETTLE_MS
  for (;;) {
    const remaining = await companion.list()
    for (const entry of remaining) {
      names.add(entry.name)
      if (entry.pid !== null) observedPids.add(entry.pid)
    }
    if (remaining.length === 0) break
    if (Date.now() >= deadline) {
      throw new Error(`Companion cleanup left sessions: ${remaining.map(describe).join(", ")}`)
    }
    for (const entry of remaining) await reapEntry(companion, entry)
    await Bun.sleep(50)
  }

  for (const pid of observedPids) {
    const pidDeadline = Date.now() + 2_000
    while (processExists(pid) && Date.now() < pidDeadline) await Bun.sleep(25)
    if (processExists(pid)) throw new Error(`Fx pid ${pid} survived an empty Companion inventory`)
  }

  const final = await companion.list()
  if (final.length !== 0) throw new Error(`final Companion inventory is not empty: ${final.map(describe).join(", ")}`)
  const document = `${JSON.stringify({
    schema_id: "fmx.phase1c-real-process-runner-cleanup",
    schema_version: 1,
    reaped: true,
    final_sessions: 0,
    observed_pids: [...observedPids].sort((left, right) => left - right),
  }, null, 2)}\n`
  const handle = await open(summary, "wx", 0o600)
  try {
    await handle.writeFile(document, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(summary, 0o600)
  const summaryFacts = await lstat(summary)
  if (!summaryFacts.isFile() || (summaryFacts.mode & 0o777) !== 0o600) {
    throw new Error("cleanup summary is not a mode-0600 regular file")
  }
  process.stdout.write(`reaped ${names.size} Companion session(s); final inventory empty\n`)
}

async function reapEntry(companion: CompanionCommand, entry: SessionEntry): Promise<void> {
  let current = entry
  if (current.state === "live") {
    await companion.kill(current.name).catch(() => {})
    current = await companion.settle(current.name, 3_000, 50).catch(() => current)
  } else if (current.state === "refused" || current.state === "unreachable") {
    current = await companion.settle(current.name, 1_000, 50).catch(() => current)
  }
  if (current.state === "live") {
    await companion.kill(current.name).catch(() => {})
    return
  }
  if (current.state === "exited") await companion.forget(current.name).catch(() => {})
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
  }
}

function describe(entry: SessionEntry): string {
  return `${entry.name}:${entry.state}${entry.pid === null ? "" : `:pid=${entry.pid}`}`
}

function parseArguments(argv: readonly string[]): { directory: string; zmxPath: string; summary: string } {
  const allowed = new Set(["--companion-directory", "--zmx-path", "--summary"])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !allowed.has(flag)) throw new Error(`unknown argument: ${flag ?? ""}`)
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`)
    if (values.has(flag)) throw new Error(`${flag} may be provided once`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined) throw new Error(`${flag} is required`)
    return value
  }
  return {
    directory: required("--companion-directory"),
    zmxPath: required("--zmx-path"),
    summary: required("--summary"),
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`fmx Phase 1C runner cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
