#!/usr/bin/env bun
/**
 * Demo: fmx's persistence foundation -- the Manifest, the join against the
 * Companion at start, and the one-fmx-per-Home agent socket.
 *
 *   FMX_ZMX_PATH=~/src/zmx/zig-out/bin/zmx bun scripts/companion-reconcile-demo.ts
 *
 * Everything happens in a private ZMX_DIR and Manifest under /tmp for this
 * run; your own Home and zmx sessions are never touched. What it creates it
 * kills at the end, and the directory is removed.
 */
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { AgentSocket, AgentSocketActiveError, defaultSocketPath } from "../src/agent-socket.ts"
import { identityFor, AgentManifest, mintIdentity } from "../src/agent-manifest.ts"
import { ownershipLabels, reconcile, reconcileAgents } from "../src/agent-reconcile.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { companionEnvironment, homeIdFor } from "../src/zmx-environment.ts"

const ZMX = process.env.FMX_ZMX_PATH
if (!ZMX) {
  console.error("set FMX_ZMX_PATH to the Companion binary (e.g. ~/src/zmx/zig-out/bin/zmx)")
  process.exit(2)
}

const PACE = Number(process.env.DEMO_PACE_MS ?? 0)
const dir = await mkdtemp("/tmp/fmxz-recon-")
const home = homeIdFor(dir)
const manifestPath = join(dir, "agents.json")
const env = companionEnvironment({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color" }, join(dir, "zmx"))
const companion = new CompanionCommand(join(dir, "zmx"), env, ZMX)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`
const step = async (text: string) => {
  await sleep(PACE)
  console.log(`\n${bold("▶ " + text)}`)
}
const say = (text: string) => console.log(`  ${text}`)
const short = (id: string) => id.slice(0, 8) + "…"
const FX = ["sh", "-c", "while IFS= read -r l; do [ \"$l\" = quit ] && exit 3; done"]
const create = (agentId: string) =>
  companion.create({
    name: identityFor(agentId).zmxName,
    command: FX,
    cwd: dir,
    env,
    labels: ownershipLabels(home, agentId),
  })
const showManifest = async () => {
  const text = existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : "(no file)"
  const doc = JSON.parse(text.startsWith("{") ? text : "{}") as { agents?: { agentId: string; displayId: number; phase: string }[] }
  say(dim(`agents.json: ${(doc.agents ?? []).map((e) => `#${e.displayId} ${short(e.agentId)} ${e.phase}`).join(", ") || "empty"}`))
}
const showSessions = async () => {
  const sessions = await companion.list()
  for (const s of sessions) say(dim(`  ${s.name.replace(/^fmx-(.{8}).*/, "fmx-$1…")}  ${s.state}${s.exit ? ` (exit ${s.exit.code}, ${s.exit.reason})` : ""}${s.labels.home ? `  home=${s.labels.home === home ? "ours" : "other"}` : ""}`))
  return sessions
}

try {
  await step(`a private Home: id ${home} (digest of ${dir})`)
  const manifest = await AgentManifest.open(manifestPath, home)
  say(`manifest ${manifestPath}`)
  say(`Companion sessions in ${join(dir, "zmx")}`)

  await step("a normal start: the Manifest claims the Agent before the Companion is asked")
  const ok = await manifest.beginCreate({ cwd: dir, fxPath: FX[0]!, fxArgs: FX.slice(1), createdAt: Date.now() })
  await showManifest()
  const okCreated = await create(ok.agentId)
  say(`Companion acknowledged: pid ${okCreated.pid} in ${okCreated.socketPath.replace(dir, "…")}`)
  await manifest.markRunning(ok.agentId)
  await showManifest()

  await step("crash #1: the entry was written, then fmx died before the Companion was asked")
  const ghost = await manifest.beginCreate({ cwd: dir, fxPath: FX[0]!, fxArgs: FX.slice(1), createdAt: Date.now() })
  say(`#${ghost.displayId} ${short(ghost.agentId)} says creating; no session exists for it`)

  await step("crash #2: the Companion acknowledged, then fmx died before marking it running")
  const half = await manifest.beginCreate({ cwd: dir, fxPath: FX[0]!, fxArgs: FX.slice(1), createdAt: Date.now() })
  await create(half.agentId)
  say(`#${half.displayId} ${short(half.agentId)} still says creating; the session is live`)

  await step("crash #3: a session this Home created, whose Manifest entry was lost entirely")
  const orphan = mintIdentity()
  await create(orphan.agentId)
  say(`${short(orphan.agentId)} is live and labeled ours; the Manifest has never heard of it`)

  await step("an Agent whose fx exited while no fmx was running")
  const ended = await manifest.beginCreate({ cwd: dir, fxPath: FX[0]!, fxArgs: FX.slice(1), createdAt: Date.now() })
  const endedCreated = await create(ended.agentId)
  await manifest.markRunning(ended.agentId)
  process.kill(endedCreated.pid, "SIGTERM")
  await companion.settle(ended.zmxName)
  say(`#${ended.displayId} ${short(ended.agentId)}: the Companion holds its exit record`)

  await step("sessions that are not ours: another Home's, and one nobody labeled")
  const foreign = mintIdentity()
  await companion.create({ name: foreign.zmxName, command: ["sleep", "60"], cwd: dir, env, labels: ownershipLabels("0000deadbeef", foreign.agentId) })
  await companion.create({ name: "hand-started", command: ["sleep", "60"], cwd: dir, env })

  await step("what the Companion holds, as found, before anything is decided")
  await showManifest()
  const sessions = await showSessions()

  await step("the join: pure, from those two inputs")
  const plan = reconcile(manifest.entries, sessions, home)
  say(`attach    ${plan.attach.map((i) => `#${i.entry.displayId}`).join(" ") || "-"}`)
  say(`adopt     ${plan.adopt.map((i) => short(i.agentId)).join(" ") || "-"}`)
  say(`remove    ${plan.remove.map((i) => `#${i.entry.displayId}${i.session ? " (exit record)" : " (no session)"}`).join(", ") || "-"}`)
  say(`unresolved ${plan.unresolved.length}   ignored ${plan.ignored.map((s) => s.name.replace(/^fmx-(.{8}).*/, "fmx-$1…")).join(", ")}`)

  await step("apply it: adopt, remove, consume the exit record")
  const outcome = await reconcileAgents(manifest, companion)
  say(`attached ${outcome.attached.length}, adopted ${outcome.adopted.map((e) => `#${e.displayId}`).join(" ")}, removed ${outcome.removed.length}`)
  await showManifest()
  await showSessions()
  say(`exit record for #${ended.displayId} consumed: inspect says ${(await companion.inspect(ended.zmxName)).state}`)

  await step("a second start finds nothing to do")
  const again = await reconcileAgents(manifest, companion)
  say(`attached ${again.attached.length}, adopted ${again.adopted.length}, removed ${again.removed.length}`)

  await step("a daemon killed -9 leaves a socket that refuses: given a settle window, then cleared")
  const unresolvedId = manifest.entries.find((e) => e.agentId === half.agentId)!
  const daemon = Bun.spawnSync(["pgrep", "-f", `create --json --labels owner=fmx home=${home} agent=${unresolvedId.agentId}`])
  const daemonPid = Number(daemon.stdout.toString().trim().split("\n")[0])
  const child = (await companion.inspect(unresolvedId.zmxName)).pid!
  process.kill(daemonPid, "SIGKILL")
  process.kill(child, "SIGKILL")
  await sleep(300)
  say(`before: inspect says ${(await companion.inspect(unresolvedId.zmxName)).state}`)
  const held = await reconcileAgents(manifest, companion, { settleMs: 500 })
  say(`cleared: ${held.cleared.map((s) => `${s.name.replace(/^fmx-(.{8}).*/, "fmx-$1…")} (was ${s.state})`).join(", ")}; removed #${held.removed.map((r) => r.entry.displayId).join(" #")}`)
  await showManifest()
  say(`socket still on disk: ${existsSync(join(dir, "zmx", unresolvedId.zmxName))}; inspect now says ${(await companion.inspect(unresolvedId.zmxName)).state}`)

  await step("one fmx per Home: the agent socket refuses a second listener and leaves the first alone")
  const socketPath = `/tmp/fmx-demo-${process.pid}.sock`
  say(`a real Home's path would be ${defaultSocketPath(home)}`)
  const first = new AgentSocket({ path: socketPath })
  await first.start()
  const second = new AgentSocket({ path: socketPath })
  try {
    await second.start()
    say("second bound?! that is the bug this exists to prevent")
  } catch (error) {
    say(`second fmx: ${error instanceof AgentSocketActiveError ? error.message : String(error)}`)
  }
  second.close()
  say(`first still listening, socket file present: ${existsSync(socketPath)}`)
  first.close()
  say(`after the first closes: ${existsSync(socketPath)}`)
} finally {
  await step("clean up: kill what is still running, remove the private directory")
  for (const s of await companion.list()) {
    if (s.state === "live") await companion.kill(s.name).catch(() => {})
  }
  await sleep(600)
  const left = (await companion.list()).filter((s) => s.state === "live")
  say(`live sessions left: ${left.length}`)
  await rm(dir, { recursive: true, force: true })
}
