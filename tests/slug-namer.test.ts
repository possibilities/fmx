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
for argument in "$@"; do asked="$argument"; done
printf '%s' "$asked" > "$FMX_TEST_ASKED"
printf '{"output":"Name Every Agent","exit_code":0}\\n'
`

type Harness = {
  fxPath: string
  env: NodeJS.ProcessEnv
  home: string
  recordPath: string
  askedPath: string
  settingsPath: string
}

async function harness(options: { prompted?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "fmx-namer-"))
  const home = join(root, "home")
  const sessionDirectory = join(home, ".fx", "sessions", SESSION)
  await mkdir(sessionDirectory, { recursive: true })
  await mkdir(join(root, "bin"), { recursive: true })

  if (options.prompted !== false) await writeFile(
    join(sessionDirectory, "events.jsonl"),
    `${JSON.stringify({
      kind: "recovery_checkpoint_set",
      payload: { checkpoint: { user: { text: "name every agent from its first prompt" } } },
    })}\n`,
    "utf8",
  )
  const settingsPath = join(home, ".fx", "settings.json")
  await writeFile(settingsPath, JSON.stringify({ provider: "codex", effort: "max" }), "utf8")

  const fxPath = join(root, "bin", "fx")
  await writeFile(fxPath, FAKE_FX, { encoding: "utf8", mode: 0o755 })

  const recordPath = join(root, "asked.log")
  const askedPath = join(root, "instruction.txt")
  await writeFile(recordPath, "", "utf8")
  return {
    fxPath,
    home,
    recordPath,
    askedPath,
    settingsPath,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      FMX_TEST_RECORD: recordPath,
      FMX_TEST_ASKED: askedPath,
    },
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
    expect(await named(namer, SESSION)).toBe("name-every-agent")

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
    expect(stored.trim()).toBe("name-every-agent")
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
    expect(second.slugFor(SESSION)).toBe("name-every-agent")
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

test("a prompt fmx typed itself names the session without waiting for fx", async () => {
  // No session log at all: fx has not written the prompt down yet, which is
  // the state naming starts in for every agent launched with one.
  const fixture = await harness({ prompted: false })
  const namer = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: defaultSlugSettings(),
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  try {
    namer.note(SESSION, { text: "name every agent", workspaceRoot: fixture.home })
    expect(await named(namer, SESSION)).toBe("name-every-agent")
  } finally {
    namer.stop()
  }
})

test("an @-mentioned file is read into the excerpt", async () => {
  const fixture = await harness({ prompted: false })
  await writeFile(join(fixture.home, "plan.md"), "rename the tabs from the prompt", "utf8")
  const namer = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: defaultSlugSettings(),
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  try {
    await mkdir(join(fixture.home, "docs"), { recursive: true })
    await writeFile(join(fixture.home, "logo.bin"), "PNG\u0000\u0001binary", "utf8")

    namer.note(SESSION, {
      text: "do @plan.md and @missing.md and @docs and @logo.bin",
      workspaceRoot: fixture.home,
    })
    await named(namer, SESSION)

    // Only a real file of text is read in; every other mention is left as the
    // word it was.
    const asked = await readFile(fixture.askedPath, "utf8")
    expect(asked).toContain(
      "do rename the tabs from the prompt and @missing.md and @docs and @logo.bin",
    )
  } finally {
    namer.stop()
  }
})

test("fx writing the prompt wakes naming, rather than a sweep noticing it", async () => {
  const fixture = await harness({ prompted: false })
  const namer = new SlugNamer({
    fxPath: fixture.fxPath,
    settings: defaultSlugSettings(),
    env: fixture.env,
    home: fixture.home,
    onSlug: () => {},
  })
  try {
    namer.note(SESSION)
    await Bun.sleep(100)

    const started = Date.now()
    await writeFile(
      join(fixture.home, ".fx", "sessions", SESSION, "events.jsonl"),
      `${JSON.stringify({
        kind: "recovery_checkpoint_set",
        payload: { checkpoint: { user: { text: "name every agent" } } },
      })}\n`,
      "utf8",
    )
    expect(await named(namer, SESSION)).toBe("name-every-agent")
    // The sweep behind the watch is five seconds; only the watch is this fast.
    expect(Date.now() - started).toBeLessThan(2_000)
  } finally {
    namer.stop()
  }
})
