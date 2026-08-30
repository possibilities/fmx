import { describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import packageMetadata from "../package.json" with { type: "json" }
import { usage } from "../src/cli.ts"
import { InvalidFmxNameError } from "../src/home.ts"
import { UI_GALLERY_COMPONENTS } from "../ui-gallery/story.ts"

const ROOT = resolve(import.meta.dir, "..")

describe("canonical public vocabulary", () => {
  test("uses fmx Session, Agent list, and Fx Conversation on primary surfaces", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")
    expect(readme).toContain("fmx Session")
    expect(readme).toContain("Agent list")
    expect(readme).toContain("Fx Conversation")
    expect(packageMetadata.description).toContain("Fx Conversations")
    expect(usage()).toContain("select an independent fmx Session")
    expect(new InvalidFmxNameError("BAD").message).toContain("invalid fmx Session name")
    expect(UI_GALLERY_COMPONENTS).toContain("Agent list")
  })

  test("keeps retired public terms and host names out of human-facing prose", async () => {
    const files = ["README.md", "CONTEXT.md", "ui-gallery/story.ts", "ui-gallery/stories.ts"]
    const docs = await readdir(join(ROOT, "docs"), { recursive: true })
    files.push(...docs.filter((path) => path.endsWith(".md")).map((path) => join("docs", path)))

    for (const file of files) {
      const text = (await readFile(join(ROOT, file), "utf8"))
        .replaceAll("$HOME", "")
        .replaceAll("XDG_CONFIG_HOME", "")
        .replace(/^_Avoid_: Home,.*$/gmu, "")
      expect(text, file).not.toMatch(/\bHome\b/u)
      expect(text, file).not.toMatch(/\bSession list\b/u)
      expect(text, file).not.toMatch(/\bHerdr\b/u)
    }
  })

  test("keeps public diagnostics and MCP descriptions free of retired wording", async () => {
    for (const file of ["src/cli.ts", "src/doctor.ts", "src/home.ts", "src/mcp-server.ts", "src/ade-events.ts"]) {
      const text = await readFile(join(ROOT, file), "utf8")
      expect(text, file).not.toMatch(/"[^"\n]*\bSession list\b[^"\n]*"/u)
      expect(text, file).not.toMatch(/`[^`\n]*another fmx Runtime[^`\n]*\bHome\b[^`\n]*`/u)
      expect(text, file).not.toMatch(/"[^"\n]*\bHerdr\b[^"\n]*"/u)
    }
  })
})
