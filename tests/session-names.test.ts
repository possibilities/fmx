import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nativeSessionName,
  NATIVE_SESSION_NAME_MAX_BYTES,
  readNativeSessionName,
  SessionNames,
} from "../src/session-names.ts"

const SESSION_ID = "1787362101388-1787362101388156000-2897385323da2683"

test("validates native names without normalizing their presentation", () => {
  expect(nativeSessionName("  Coordinate the review  ")).toBe("  Coordinate the review  ")
  expect(nativeSessionName("Ship: macOS + Linux")).toBe("Ship: macOS + Linux")
  expect(nativeSessionName("   ")).toBeNull()
  expect(nativeSessionName("bad\nname")).toBeNull()
  expect(nativeSessionName("x".repeat(NATIVE_SESSION_NAME_MAX_BYTES + 1))).toBeNull()
})

test("recovers fx's durable display authority and applies newer ADE names", async () => {
  const home = await mkdtemp(join(tmpdir(), "fmx-native-name-"))
  const directory = join(home, ".fx", "sessions", SESSION_ID)
  await mkdir(directory, { recursive: true })
  const display = join(directory, "display.json")
  await writeFile(display, JSON.stringify({ schema_version: 1, title: "Durable native name" }))

  try {
    expect(readNativeSessionName(SESSION_ID, { HOME: home })).toBe("Durable native name")
    const names = new SessionNames({ home })
    expect(names.recover(SESSION_ID)).toBe(true)
    expect(names.nameFor(SESSION_ID)).toBe("Durable native name")
    expect(names.apply(SESSION_ID, "ADE native name")).toBe(true)
    expect(names.nameFor(SESSION_ID)).toBe("ADE native name")
    expect(names.apply(SESSION_ID, "ADE native name")).toBe(false)

    await rm(display)
    expect(names.recover(SESSION_ID)).toBe(true)
    expect(names.nameFor(SESSION_ID)).toBeNull()
    expect(names.apply("../escape", "Unsafe identity")).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
