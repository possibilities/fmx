#!/usr/bin/env bun
/**
 * Demo: a fresh fmx install needs no zmx of its own.
 *
 *   bun scripts/companion-install-demo.ts
 *
 * The release archives for this host are built (`scripts/build-release.sh`)
 * unless `dist/release` already holds them — `DEMO_REBUILD=1` builds them
 * again — and served over a local HTTP server the way the public store
 * serves them. The server also exposes a fixture implementation of the
 * separately published fmx-fx installer, installing the same fake Fx the
 * Runtime half of this demo exercises. The published installer is run against
 * that server into a temporary directory, with a PATH that has no zmx, no
 * fmx-zmx, and no FMX_ZMX_PATH in the environment. `fmx doctor` shows the installed trio;
 * the same fmx next to a companion that is not the pinned build is refused.
 * Then the installed fmx runs for real, under a private Home, with the test
 * fixture's fake fx as its agent: one agent is started, fmx is SIGKILLed,
 * the bundled companion's own command line lists the survivor, and a second
 * fmx restores it. `DEMO_PACE_MS` slows the steps down for watching.
 * Everything the demo creates is removed at the end.
 */
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import companionPin from "../companion.json" with { type: "json" }
import fxPin from "../fx.json" with { type: "json" }
import packageMetadata from "../package.json" with { type: "json" }
import { defaultAdeSocketPath } from "../src/ade-events.ts"
import { BusSocket } from "../src/bus-socket.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { homeIdFor } from "../src/zmx-environment.ts"

const PACE = Number(process.env.DEMO_PACE_MS ?? 0)
const ROOT = resolve(import.meta.dir, "..")
const FAKE_FX = join(ROOT, "tests/fixtures/fake-fx.ts")
const VERSION = packageMetadata.version
const platform = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`
const releaseDirectory = process.env.FMX_RELEASE_DIR ?? join(ROOT, "dist", "release")
const archive = `fmx-${platform}.tar.xz`

const step = async (text: string) => {
  console.log(`\n\x1b[1m▶ ${text}\x1b[0m`)
  if (PACE) await Bun.sleep(PACE)
}
const note = (text: string) => console.log(`  ${text}`)
const show = (text: string) => console.log(text.trimEnd().split("\n").map((line) => `    ${line}`).join("\n"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
const run = async (command: string[], env: Record<string, string>, cwd = ROOT) => {
  const proc = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { code: proc.exitCode, stdout, stderr }
}

// A PATH with the system's tools and bun (the fake fx is a bun script), and
// nothing that could be a zmx: the installed pair is all there is.
const bunDirectory = dirname(process.execPath)
const scrubbedPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", bunDirectory].join(":")
const baseEnvironment: Record<string, string> = {
  PATH: scrubbedPath,
  HOME: process.env.HOME ?? "/",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: process.env.LANG ?? "en_US.UTF-8",
}
for (const name of ["zmx", "fmx-zmx"]) {
  if (Bun.which(name, { PATH: scrubbedPath })) throw new Error(`${name} is on the scrubbed PATH; the demo cannot prove anything`)
}

const temp = await mkdtemp("/tmp/fmx-install-demo-")
const installDirectory = join(temp, "bin")
const companionDirectory = `/tmp/fmxz-demo-${basename(temp).slice(-6)}`
const home = homeIdFor(join(temp, "config", "fmx"))
const busSocketPath = BusSocket.pathFor(defaultAdeSocketPath(home))
const lifecycleLog = join(temp, "lifecycle.log")
await writeFile(join(temp, "config.toml"), `project_roots = [${JSON.stringify(ROOT)}]\n`)
const fmxEnvironment: Record<string, string> = {
  ...baseEnvironment,
  FMX_FX_PATH: FAKE_FX,
  // A repository to launch into: an agent runs in one or it does not run.
  FMX_CONFIG_PATH: join(temp, "config.toml"),
  FMX_STATE_PATH: join(temp, "state.json"),
  XDG_CONFIG_HOME: join(temp, "config"),
  FMX_ZMX_DIR: companionDirectory,
  FMX_MANIFEST_PATH: join(temp, "agents.json"),
  FMX_TEST_LOG: lifecycleLog,
  FMX_TEST_HEARTBEAT: "1",
  FMX_TEST_PASSTHROUGH_KEYS: "1",
}
const decoder = new TextDecoder()
const lifecycle = async () => readFile(lifecycleLog, "utf8").catch(() => "")
const visibleText = (output: string) =>
  output.replace(/\x1b\][^]*?(?:\x07|\x1b\\)/g, " ").replace(/\x1b\[[0-9;?<>=]*[A-Za-z]/g, " ")
const banners = (output: string) => visibleText(output).match(/fake\s+fx\s+ready/g)?.length ?? 0
const CTRL = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

/** The Fx repository owns its checksum-verifying public installer. This local
 * demo needs only its contract boundary: install the exact requested pin as
 * `fmx-fx`, then let fmx's own doctor verify the compatibility probe. */
const fixtureFxSetup = (origin: string) => `#!/usr/bin/env bash
set -euo pipefail
install_dir="\${FMX_FX_INSTALL_DIR:?}"
requested="\${FMX_FX_VERSION:?}"
[[ "$requested" == ${JSON.stringify(fxPin.commit)} ]] || { echo 'fixture fmx-fx pin mismatch' >&2; exit 1; }
mkdir -p "$install_dir"
temporary="$(mktemp "$install_dir/.fmx-fx.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
curl --fail --silent --show-error --location ${JSON.stringify(`${origin}/fx/fmx-fx`)} -o "$temporary"
chmod 0755 "$temporary"
mv -f "$temporary" "$install_dir/fmx-fx"
trap - EXIT
"$install_dir/fmx-fx" --fxnk-version
`

type Fmx = { process: ReturnType<typeof Bun.spawn>; output: () => string; key: (...bytes: number[]) => void }
const startFmx = (executable: string): Fmx => {
  let output = ""
  const process_ = Bun.spawn([executable], {
    cwd: temp,
    env: fmxEnvironment,
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

let server: ReturnType<typeof Bun.serve> | null = null
let first: Fmx | null = null
let second: Fmx | null = null
let companion: CompanionCommand | null = null
try {
  await step(`release archives for ${platform}, fmx ${VERSION} with companion ${companionPin.build}`)
  const archivePath = join(releaseDirectory, archive)
  const haveArchives = (await Bun.file(archivePath).exists()) && (await Bun.file(`${archivePath}.sha256`).exists())
  if (haveArchives && process.env.DEMO_REBUILD !== "1") {
    note(`using ${archivePath} (DEMO_REBUILD=1 builds it again)`)
  } else {
    note(`building with scripts/build-release.sh ${platform} (fetches the pinned fork and builds it; this takes a few minutes)`)
    const build = Bun.spawn(["scripts/build-release.sh", platform], { cwd: ROOT, env: { ...process.env, FMX_RELEASE_DIR: releaseDirectory }, stdout: "inherit", stderr: "inherit" })
    if ((await build.exited) !== 0) throw new Error("the release build failed")
  }

  await step("serve the archives the way the public store does, and publish the installer against that server")
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/latest.txt") return new Response(`v${VERSION}`)
      if (path === "/fx/setup.sh") return new Response(fixtureFxSetup(url.origin))
      if (path === "/fx/fmx-fx") return new Response(Bun.file(FAKE_FX))
      const match = /^\/releases\/v([^/]+)\/([^/]+)$/.exec(path)
      if (match && match[1] === VERSION) return new Response(Bun.file(join(releaseDirectory, match[2]!)))
      return new Response("not found", { status: 404 })
    },
  })
  const baseUrl = `http://127.0.0.1:${server.port}`
  const publishedSetup = join(temp, "setup.sh")
  await writeFile(
    publishedSetup,
    (await readFile(join(ROOT, "setup.sh"), "utf8"))
      .replaceAll("__FMX_RELEASE_BASE_URL__", baseUrl)
      .replaceAll("__FMX_FX_SETUP_URL__", `${baseUrl}/fx/setup.sh`),
  )
  note(`${baseUrl}/latest.txt → v${VERSION}; ${baseUrl}/releases/v${VERSION}/${archive}`)

  await step(`run the installer into ${installDirectory} with PATH=${scrubbedPath}`)
  const installed = await run(["bash", publishedSetup], { ...baseEnvironment, FMX_INSTALL_DIR: installDirectory })
  show(installed.stdout + installed.stderr)
  if (installed.code !== 0) throw new Error(`the installer exited ${installed.code}`)

  await step("fmx doctor: the installed fmx finds the companion beside itself and it is the pinned build")
  const doctor = await run([join(installDirectory, "fmx"), "doctor"], fmxEnvironment)
  show(doctor.stdout + doctor.stderr)
  note(`exit ${doctor.code}`)
  if (doctor.code !== 0) throw new Error("doctor did not accept the installed pair")

  const other = process.env.DEMO_OTHER_COMPANION ?? join(process.env.HOME ?? "", "src/zmx/zig-out/bin/zmx")
  if (await Bun.file(other).exists()) {
    await step(`the same fmx beside a companion that is not the pinned build (${other}) is refused`)
    const wrong = join(temp, "wrong")
    await mkdir(wrong)
    await cp(join(installDirectory, "fmx"), join(wrong, "fmx"))
    await cp(other, join(wrong, "fmx-zmx"))
    await chmod(join(wrong, "fmx-zmx"), 0o755)
    const refused = await run([join(wrong, "fmx"), "doctor"], fmxEnvironment)
    show(refused.stdout + refused.stderr)
    note(`exit ${refused.code}`)
    if (refused.code === 0) throw new Error("doctor accepted a companion that is not the pinned build")
    await rm(wrong, { recursive: true, force: true })
  }

  await step(`start the installed fmx under a private Home (${home}); the companion keeps sessions in ${companionDirectory}`)
  companion = new CompanionCommand(companionDirectory, baseEnvironment, join(installDirectory, "fmx-zmx"))
  first = startFmx(join(installDirectory, "fmx"))
  await until(() => first!.output().includes("no agents"), "the empty state")
  note(`fmx is pid ${first.process.pid}, showing its empty state`)

  await step("launch from the CLI: one agent, created by the bundled companion")
  const launched = await run(
    [join(installDirectory, "fmx"), "control", "launch", "--socket", busSocketPath, "--project", ROOT],
    fmxEnvironment,
    temp,
  )
  if (launched.code !== 0) throw new Error(`launch failed: ${(launched.stderr || launched.stdout).trim()}`)
  await until(async () => (await lifecycle()).includes("ready 1"), "agent 1")
  await until(async () => (await companion!.list()).some((s) => s.state === "live"), "the companion to hold it")
  for (const session of await companion.list()) note(`companion: ${session.name} ${session.state} pid ${session.pid}`)

  await step("SIGKILL fmx")
  process.kill(first.process.pid, "SIGKILL")
  await first.process.exited
  first.process.terminal?.close()
  const before = (await lifecycle()).split("alive 1 ").length
  await sleep(400)
  const after = (await lifecycle()).split("alive 1 ").length
  note(`agent 1 heartbeats ${before} → ${after}: still running`)

  await step("the bundled companion's own command line sees it: fmx-zmx list")
  const listed = await run([join(installDirectory, "fmx-zmx"), "list"], { ...baseEnvironment, ZMX_DIR: companionDirectory })
  show(listed.stdout + listed.stderr)
  note("(ZMX_DIR names the demo's private directory; an installed companion defaults to /tmp/fmx-<uid>/zmx, where fmx keeps them)")

  await step("start the installed fmx again: it attaches the survivor and restores its screen")
  second = startFmx(join(installDirectory, "fmx"))
  await until(() => banners(second!.output()) >= 1, "a restored screen")
  note(`fmx is pid ${second.process.pid}; agents started by the new fmx: ${((await lifecycle()).match(/^start /gm)?.length ?? 0) - 1}`)

  await step("ctrl-c ctrl-c inside the agent, then ctrl-c twice in the empty state: fmx exits")
  second.key(CTRL("c"), CTRL("c"))
  await until(async () => (await lifecycle()).includes("graceful 1"), "the agent to exit")
  await until(() => second!.output().includes("no agents"), "the empty state")
  await sleep(300)
  second.key(CTRL("c"))
  await until(() => second!.output().includes("press ctrl+c again to exit"), "the exit confirmation")
  second.key(CTRL("c"))
  await second.process.exited
  note(`fmx exited with ${second.process.exitCode}`)
  console.log("\n\x1b[1m✓ a fresh install needs no system zmx\x1b[0m")
} finally {
  server?.stop(true)
  for (const fmx of [first, second]) {
    if (fmx && fmx.process.exitCode === null) fmx.process.kill("SIGKILL")
    fmx?.process.terminal?.close()
  }
  if (companion) {
    for (const session of await companion.list().catch(() => [])) {
      if (session.state === "live") await companion.kill(session.name).catch(() => {})
    }
    await until(async () => (await companion!.list().catch(() => [])).every((s) => s.state !== "live" && s.state !== "refused"), "cleanup", 8000).catch(() => {})
  }
  await rm(companionDirectory, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
}
