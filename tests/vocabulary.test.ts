import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import packageMetadata from "../package.json" with { type: "json" }
import { usage } from "../src/cli.ts"
import { InvalidInstanceNameError } from "../src/instance.ts"
import { METHOD_NAMES } from "../src/protocol.ts"

const ROOT = resolve(import.meta.dir, "..")

/**
 * Every document that describes fmx as it is. Decision records are history
 * and keep the words they were written with; a superseded one says so at the
 * top instead of being rewritten.
 */
async function prose(): Promise<[string, string][]> {
  const docs = await readdir(join(ROOT, "docs"), { recursive: true })
  const files = [
    "README.md",
    "CONTEXT.md",
    ...docs.filter((path) => path.endsWith(".md") && !path.startsWith("adr/")).map((path) => join("docs", path)),
  ]
  return Promise.all(files.map(async (file) => [file, await readFile(join(ROOT, file), "utf8")] as [string, string]))
}

describe("canonical public vocabulary", () => {
  test("uses Instance, Session, Layout, and Pane on primary surfaces", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")
    for (const term of ["Instance", "Session", "Layout", "Pane", "Companion"]) {
      expect(readme).toContain(term)
    }
    expect(packageMetadata.description).toContain("multiplexer")
    expect(usage()).toContain("select an independent Instance")
    expect(new InvalidInstanceNameError("BAD").message).toContain("invalid Instance name")
  })

  test("keeps the retired agent vocabulary out of human-facing prose", async () => {
    for (const [file, text] of await prose()) {
      for (const retired of [
        "\\bAgent\\b",
        "\\bTray\\b",
        "\\bAgent list\\b",
        "\\bfmx Session\\b",
        "\\bManifest\\b",
        "\\bHome\\b",
        "\\bHerdr\\b",
        "\\bfmx-mcp\\b",
      ]) {
        expect(text, `${file} still says ${retired}`).not.toMatch(new RegExp(retired, "u"))
      }
    }
  })

  test("keeps public diagnostics free of retired wording", async () => {
    for (const file of ["src/cli.ts", "src/doctor.ts", "src/instance.ts", "src/protocol.ts"]) {
      const text = await readFile(join(ROOT, file), "utf8")
      for (const retired of ["\\bTray\\b", "\\bAgent list\\b", "\\bHerdr\\b"]) {
        expect(text, `${file} still says ${retired}`).not.toMatch(new RegExp(`"[^"\\n]*${retired}[^"\\n]*"`, "u"))
      }
    }
  })

  test("every decision the rewrite overturned says what replaced it", async () => {
    const superseded = [
      "0005-agent-tray-vocabulary.md",
      "0007-companion-held-shared-runtime.md",
      "0008-ade-only-fx-lifecycle.md",
      "0009-pinned-private-fx-install.md",
      "0013-mcp-only-agent-automation.md",
      "0014-independent-named-fmx.md",
    ]
    const replacements = await Promise.all(
      ["0015", "0016", "0017", "0018"].map(async (number) => {
        const files = await readdir(join(ROOT, "docs/adr"))
        const file = files.find((path) => path.startsWith(number))!
        return readFile(join(ROOT, "docs/adr", file), "utf8")
      }),
    )
    for (const record of superseded) {
      expect(replacements.some((text) => text.includes(record)), `nothing supersedes ${record}`).toBe(true)
    }
  })

  test("documents every method the contract defines", async () => {
    const api = await readFile(join(ROOT, "docs/api.md"), "utf8")
    for (const method of METHOD_NAMES) {
      expect(api, `docs/api.md omits ${method}`).toContain(`## \`${method}\``)
    }
  })
})
