import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSlugSettings } from "../src/config.ts"
import { inferenceWorkspace } from "../src/fx-profile.ts"
import { SlugNamer } from "../src/slug-namer.ts"

const SESSION = "1787362101388-1787362101388156000-2897385323da2683"

/**
 * A stand-in for fx that answers the way `fx ask --json` does, recording the
 * environment it was asked in so the test can see the model and workspace the
 * completion actually ran with.
 */
const FAKE_FX = `#!/bin/sh
printf '%s|%s\\n' "$FX_MODEL" "$PWD" >> "$FMX_TEST_RECORD"
printf '{"output":"Name Every Instance","exit_code":0}\\n'
`

type Harness = {
  fxPath: string
  env: NodeJS.ProcessEnv
  home: string
  recordPath: string
  settingsPath: string
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "fmx-namer-"))
  const home = join(root, "home")
  const sessionDirectory = join(home, ".fx", "sessions", SESSION)
  await mkdir(sessionDirectory, { recursive: true })
  await mkdir(join(root, "bin"), { recursive: true })

  await writeFile(
    join(sessionDirectory, "events.jsonl"),
    `${JSON.stringify({
      kind: "recovery_checkpoint_set",
      payload: { checkpoint: { user: { text: "name every instance from its first prompt" } } },
    })}\n`,
    "utf8",
  )
  const settingsPath = join(home, ".fx", "settings.json")
  await writeFile(settingsPath, JSON.stringify({ provider: "codex", effort: "max" }), "utf8")

  const fxPath = join(root, "bin", "fx")
  await writeFile(fxPath, FAKE_FX, { encoding: "utf8", mode: 0o755 })

  const recordPath = join(root, "asked.log")
  await writeFile(recordPath, "", "utf8")
  return {
    fxPath,
    home,
    recordPath,
    settingsPath,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "config"), FMX_TEST_RECORD: recordPath },
  }
}

function named(namer: SlugNamer, sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no slug within the test's patience")), 10_000)
    const poll = setInterval(() => {
      const slug = namer.slugFor(sessionId)
      if (slug === null) return
      clearInterval(poll)
      clearTimeout(timer)
      resolve(slug)
    }, 10)
  })
}

test("names a session from its first prompt, at the provider's small model", async () => {
  const fixture = await harness()
  const namer = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: defaultSlugSettings(),
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  try {
    namer.note(SESSION)
    expect(await named(namer, SESSION)).toBe("name-every-instance")

    const workspace = inferenceWorkspace(fixture.env, fixture.home)
    const [model, askedIn] = (await readFile(fixture.recordPath, "utf8")).trim().split("|")
    expect(model).toBe("gpt-5.4-mini")
    // The recorded path is the shell's own, which on macOS resolves /var.
    expect(askedIn!.endsWith(join("fmx", "inference"))).toBe(true)

    // The slug outlives this fmx, and fx learned to name at a cheap effort.
    const stored = await readFile(
      join(fixture.env.XDG_CONFIG_HOME!, "fmx", "slugs", SESSION),
      "utf8",
    )
    expect(stored.trim()).toBe("name-every-instance")
    const settings = JSON.parse(await readFile(fixture.settingsPath, "utf8"))
    expect(settings.effort).toBe("max")
    expect(settings.workspaces[workspace]).toEqual({ effort: "low" })
  } finally {
    namer.stop()
  }
})

test("a stored slug is answered without paying for another completion", async () => {
  const fixture = await harness()
  const first = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: defaultSlugSettings(),
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  first.note(SESSION)
  await named(first, SESSION)
  first.stop()

  const second = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: defaultSlugSettings(),
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  try {
    second.note(SESSION)
    expect(second.slugFor(SESSION)).toBe("name-every-instance")
    expect((await readFile(fixture.recordPath, "utf8")).trim().split("\n")).toHaveLength(1)
  } finally {
    second.stop()
  }
})

test("naming that is turned off never reaches for fx", async () => {
  const fixture = await harness()
  const namer = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: { ...defaultSlugSettings(), enabled: false },
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  try {
    namer.note(SESSION)
    await Bun.sleep(50)
    expect(namer.slugFor(SESSION)).toBeNull()
    expect(await readFile(fixture.recordPath, "utf8")).toBe("")
  } finally {
    namer.stop()
  }
})
