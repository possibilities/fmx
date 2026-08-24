#!/usr/bin/env bun
/**
 * Demo: fmx is killed and restarted, and its agents never notice.
 *
 *   FMX_ZMX_PATH=~/src/zmx/zig-out/bin/zmx bun scripts/companion-restart-demo.ts
 *
 * The real fmx runs in a PTY here, under a private Home, Manifest, and
 * Companion directory, with the test fixture's fake fx as its agent. Two
 * agents are started; fmx is SIGKILLed; both keep running in the Companion;
 * a second fmx under the same Home finds both, restores their screens, and
 * takes input for them; then each exits on its own and the last exit closes
 * fmx. `DEMO_PACE_MS` slows the steps down for watching. Everything the demo
 * creates is removed at the end.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { loadManifest } from "../src/agent-manifest.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { homeIdFor } from "../src/zmx-environment.ts"

const ZMX = process.env.FMX_ZMX_PATH
if (!ZMX) {
  console.error("set FMX_ZMX_PATH to the Companion binary (e.g. ~/src/zmx/zig-out/bin/zmx)")
  process.exit(2)
}
const PACE = Number(process.env.DEMO_PACE_MS ?? 0)
const ROOT = resolve(import.meta.dir, "..")
const FAKE_FX = join(ROOT, "tests/fixtures/fake-fx.ts")

const temp = await mkdtemp("/tmp/fmx-restart-demo-")
const companionDirectory = `/tmp/fmxz-demo-${basename(temp).slice(-6)}`
const home = homeIdFor(join(temp, "config", "fmx"))
const lifecycleLog = join(temp, "lifecycle.log")
const manifestPath = join(temp, "agents.json")
const configFile = join(temp, "config.toml")
await writeFile(configFile, `project_roots = [${JSON.stringify(ROOT)}]\n`)
const env = {
  ...process.env,
  FMX_FX_PATH: FAKE_FX,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  // A repository to launch into: an agent runs in one or it does not run.
  FMX_CONFIG_PATH: configFile,
  FMX_STATE_PATH: join(temp, "state.json"),
  XDG_CONFIG_HOME: join(temp, "config"),
  FMX_ZMX_PATH: ZMX,
  FMX_ZMX_DIR: companionDirectory,
  FMX_MANIFEST_PATH: manifestPath,
  FMX_TEST_LOG: lifecycleLog,
  FMX_TEST_HEARTBEAT: "1",
  FMX_TEST_PASSTHROUGH_KEYS: "1",
}
const companion = new CompanionCommand(companionDirectory, process.env, ZMX)
const decoder = new TextDecoder()
const step = async (text: string) => {
  console.log(`\n[1m▶ ${text}[0m`)
  if (PACE) await Bun.sleep(PACE)
}
const note = (text: string) => console.log(`  ${text}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lifecycle = async () => readFile(lifecycleLog, "utf8").catch(() => "")
const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
const heartbeats = async (id: number) => (await lifecycle()).split(`alive ${id} `).length - 1
const visibleText = (output: string) =>
  output.replace(/\][^]*(?:|\\)/g, " ").replace(/\[[0-9;?<>=]*[A-Za-z]/g, " ")
const banners = (output: string) => visibleText(output).match(/fake\s+fx\s+ready/g)?.length ?? 0
const showManifest = async () => {
  const manifest = await loadManifest(manifestPath, home)
  if (manifest.agents.length === 0) note("Manifest: no Agents")
  for (const entry of manifest.agents) {
    note(`Manifest: Agent ${entry.displayId} ${entry.phase}, session ${entry.zmxName}`)
  }
}
const showCompanion = async () => {
  const sessions = await companion.list()
  if (sessions.length === 0) note("Companion: no sessions")
  for (const session of sessions) {
    note(`Companion: ${session.name} ${session.state}${session.pid ? ` pid ${session.pid}` : ""}${session.clients !== null ? `, ${session.clients} client(s)` : ""}`)
  }
}
const CTRL = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

/** ctrl-b l opens the launch dialog; the returns commit the empty prompt and
 * launch into the project it opened on. */
const launch = async (fmx: Fmx) => {
  const drawn = fmx.output().split(LAUNCH_PROMPT_ROW).length
  fmx.key(CTRL("b"), "l".charCodeAt(0))
  await until(() => fmx.output().split(LAUNCH_PROMPT_ROW).length > drawn, "the launch dialog")
  fmx.key(13)
  await sleep(50)
  fmx.key(13)
}
const LAUNCH_PROMPT_ROW = "what should the agent do?"

type Fmx = { process: ReturnType<typeof Bun.spawn>; output: () => string; key: (...bytes: number[]) => void }
const startFmx = (): Fmx => {
  let output = ""
  const process_ = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: ROOT,
    env,
    terminal: {
      cols: 100,
      rows: 24,
      data: (_terminal, bytes) => {
        output += decoder.decode(bytes, { stream: true })
      },
    },
  })
  return {
    process: process_,
    output: () => output,
    key: (...bytes) => process_.terminal?.write(Uint8Array.of(...bytes)),
  }
}

let first: Fmx | null = null
let second: Fmx | null = null
try {
  await step(`start fmx under a private Home (${home}); its Companion keeps sessions in ${companionDirectory}`)
  first = startFmx()
  await until(() => first!.output().includes("prefix+l"), "the empty state")
  note(`fmx is pid ${first.process.pid}, showing its empty state`)

  await step("ctrl-b l twice: two agents, each created in the Companion, not spawned by fmx")
  await launch(first)
  await until(async () => (await lifecycle()).includes("ready 1"), "agent 1")
  await launch(first)
  await until(async () => (await lifecycle()).includes("ready 2"), "agent 2")
  await until(async () => (await loadManifest(manifestPath, home)).agents.every((e) => e.phase === "running"), "both claims acknowledged")
  await showManifest()
  await showCompanion()

  await step("SIGKILL fmx: no chance to clean up, nothing sent to either agent")
  process.kill(first.process.pid, "SIGKILL")
  await first.process.exited
  first.process.terminal?.close()
  note(`fmx exited with ${first.process.exitCode ?? "a signal"}`)
  const before = [await heartbeats(1), await heartbeats(2)]
  await sleep(400)
  const after = [await heartbeats(1), await heartbeats(2)]
  note(`agent 1 heartbeats ${before[0]} → ${after[0]}, agent 2 ${before[1]} → ${after[1]}: both still running`)
  note(`ctrl-c seen by an agent: ${(await lifecycle()).includes("ctrl-c") ? "yes" : "no"}`)
  await showCompanion()

  await step("start fmx again under the same Home: it joins the Manifest with the Companion and attaches both")
  second = startFmx()
  await until(() => banners(second!.output()) >= 1, "a restored screen")
  await sleep(300)
  note(`fmx is pid ${second.process.pid}; agents started by the new fmx: ${((await lifecycle()).match(/^start /gm)?.length ?? 0) - 2}`)
  note(`the visible terminal shows the selected agent's restored banner (${banners(second.output())} on screen so far)`)
  await showManifest()
  await showCompanion()

  // state.json remembers the selected Agent by identity, so the restore comes
  // back on agent 2 — the one that was on screen when fmx was killed.
  await step("type into the restored agent: ctrl-u reaches agent 2")
  second.key(CTRL("u"))
  await until(async () => (await lifecycle()).includes("ctrl-u 2"), "agent 2 to see ctrl-u")
  note("agent 2 logged ctrl-u")

  await step("ctrl-c ctrl-c inside agent 2: its own exit removes it, and only it")
  second.key(CTRL("c"), CTRL("c"))
  await until(async () => (await lifecycle()).includes("graceful 2"), "agent 2 to exit")
  await until(async () => (await loadManifest(manifestPath, home)).agents.length === 1, "its claim to go")
  await showManifest()
  const remaining = (await loadManifest(manifestPath, home)).agents[0]!.zmxName
  // The Runtime holds a Companion session of its own (`fmxr-`); only the
  // Agent sessions (`fmx-`) are what this step is counting.
  await until(
    async () => (await companion.list()).filter((s) => s.name.startsWith("fmx-")).every((s) => s.name === remaining),
    "its record to be consumed",
    8000,
  )
  await showCompanion()

  await step("ctrl-c ctrl-c inside agent 1: the last exit leaves the empty state, and ctrl-c twice closes fmx")
  second.key(CTRL("c"), CTRL("c"))
  await until(async () => (await lifecycle()).includes("graceful 1"), "agent 1 to exit")
  await until(() => second!.output().includes("prefix+l to launch agent"), "the empty state")
  await sleep(300)
  second.key(CTRL("c"))
  await until(() => second!.output().includes("press ctrl+c again to exit"), "the exit confirmation")
  second.key(CTRL("c"))
  await second.process.exited
  note(`fmx exited with ${second.process.exitCode}`)
  // fmx left the moment the last exit was shown; the record the daemon writes
  // a beat later is the next start's to consume. Nothing is running.
  await until(async () => (await companion.list()).every((s) => s.state === "exited" || s.state === "absent"), "the last daemon to finish", 8000)
  await showManifest()
  await showCompanion()
  note("(an exit record left behind is consumed by the next start's join)")
  console.log("\n[1m✓ kill and restart is routine[0m")
} finally {
  for (const fmx of [first, second]) {
    if (fmx && fmx.process.exitCode === null) fmx.process.kill("SIGKILL")
    fmx?.process.terminal?.close()
  }
  for (const session of await companion.list().catch(() => [])) {
    if (session.state === "live") await companion.kill(session.name).catch(() => {})
  }
  await until(async () => (await companion.list().catch(() => [])).every((s) => s.state !== "live" && s.state !== "refused"), "cleanup", 8000).catch(() => {})
  await rm(companionDirectory, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
}
