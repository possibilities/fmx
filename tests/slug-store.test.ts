import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claimNaming,
  readSlug,
  releaseNaming,
  resolveRef,
  slugDirectory,
  storeSlug,
} from "../src/slug-store.ts"

const SESSION = "1787362101388-1787362101388156000-2897385323da2683"
const OTHER = "1787361995570-1787361995570456000-cf36d53fea46f4d3"

function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fmx-slugs-"))
}

describe("slugDirectory", () => {
  test("sits beside the rest of what fmx keeps", () => {
    expect(slugDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg/fmx/slugs")
    expect(slugDirectory({}, "/home/me")).toBe("/home/me/.config/fmx/slugs")
  })
})

describe("storeSlug", () => {
  test("round-trips a slug through the store, creating the directory", async () => {
    const path = join(await directory(), "nested")
    expect(storeSlug(path, SESSION, "name-every-instance")).toBe("name-every-instance")
    expect(readSlug(path, SESSION)).toBe("name-every-instance")
    expect(await readFile(join(path, SESSION), "utf8")).toBe("name-every-instance\n")
  })

  test("suffixes a slug another session already answers to", async () => {
    const path = await directory()
    expect(storeSlug(path, OTHER, "fix-the-selection")).toBe("fix-the-selection")
    expect(storeSlug(path, SESSION, "fix-the-selection")).toBe("fix-the-selection-2")
    expect(readSlug(path, OTHER)).toBe("fix-the-selection")
  })

  test("renaming a session does not collide with its own old slug", async () => {
    const path = await directory()
    storeSlug(path, SESSION, "first-name")
    expect(storeSlug(path, SESSION, "first-name")).toBe("first-name")
  })

  test("refuses a session id it will not join to a path", async () => {
    expect(storeSlug(await directory(), "../escape", "slug")).toBeNull()
  })

  test("answers null when the store cannot be written", async () => {
    const path = join(await directory(), "file")
    await writeFile(path, "not a directory", "utf8")
    expect(storeSlug(path, SESSION, "slug")).toBeNull()
  })
})

describe("resolveRef", () => {
  test("resolves a slug to its session, and a session id to itself", async () => {
    const path = await directory()
    storeSlug(path, SESSION, "name-every-instance")
    expect(resolveRef(path, "name-every-instance")).toBe(SESSION)
    expect(resolveRef(path, SESSION)).toBe(SESSION)
  })

  test("answers null for a name nothing answers to", async () => {
    expect(resolveRef(await directory(), "no-such-name")).toBeNull()
    expect(resolveRef(await directory(), OTHER)).toBeNull()
  })
})

describe("claimNaming", () => {
  test("elects one owner and releases the claim back", async () => {
    const path = await directory()
    expect(claimNaming(path, SESSION)).toBe(true)
    // A claim this process already holds is its own; a foreign live one is not.
    await writeFile(join(path, `${SESSION}.naming`), "1\n", "utf8")
    expect(claimNaming(path, SESSION)).toBe(false)
    releaseNaming(path, SESSION)
    expect(claimNaming(path, SESSION)).toBe(true)
  })

  test("takes over a claim whose owner is gone", async () => {
    const path = await directory()
    await writeFile(join(path, `${SESSION}.naming`), "not-a-pid\n", "utf8")
    expect(claimNaming(path, SESSION)).toBe(true)
  })

  test("a claim is not a slug", async () => {
    const path = await directory()
    claimNaming(path, SESSION)
    expect(resolveRef(path, String(process.pid))).toBeNull()
    expect(readSlug(path, SESSION)).toBeNull()
  })
})
