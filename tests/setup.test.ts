import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SUPPORTED_HOST =
  (process.platform === "darwin" || process.platform === "linux") &&
  (process.arch === "arm64" || process.arch === "x64")

test.skipIf(!SUPPORTED_HOST)("setup installs a verified pair from the gzip fallback, and nothing from a bad checksum or a lone fmx", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-setup-test-"))
  const payloadDirectory = join(tempDirectory, "payload")
  const releaseDirectory = join(tempDirectory, "release")
  const version = "9.8.7"
  const companionBuild = "0.7.0+fmx.0123456789ab"
  const os = process.platform === "darwin" ? "macos" : "linux"
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
  const archiveName = `fmx-${os}-${arch}.tar.gz`
  const archivePath = join(releaseDirectory, archiveName)
  let corruptChecksum = false
  let archive: "pair" | "lone" = "pair"

  await mkdir(payloadDirectory)
  await mkdir(releaseDirectory)
  await writeFile(
    join(payloadDirectory, "fmx"),
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\nexit 0\n`,
  )
  await chmod(join(payloadDirectory, "fmx"), 0o755)
  // The companion answers \`version\` the way the fork does: a tab-separated table whose first line is the build.
  await writeFile(
    join(payloadDirectory, "fmx-zmx"),
    `#!/bin/sh\nif [ "\${1:-}" = "version" ]; then printf 'zmx\\t\\t%s\\nsocket_dir\\t/tmp/x\\n' '${companionBuild}'; exit 0; fi\nexit 0\n`,
  )
  await chmod(join(payloadDirectory, "fmx-zmx"), 0o755)
  await writeFile(join(payloadDirectory, "LICENSE"), "test license\n")
  await writeFile(join(payloadDirectory, "THIRD_PARTY_NOTICES.md"), "test notices\n")

  const pack = async (members: string[]): Promise<{ bytes: ArrayBuffer; checksum: string }> => {
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", payloadDirectory, ...members], { stdout: "inherit", stderr: "inherit" })
    expect(await tar.exited).toBe(0)
    const bytes = await Bun.file(archivePath).arrayBuffer()
    return { bytes, checksum: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }
  }
  const lone = await pack(["fmx", "LICENSE", "THIRD_PARTY_NOTICES.md"])
  const pair = await pack(["fmx", "fmx-zmx", "LICENSE", "THIRD_PARTY_NOTICES.md"])

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      const served = archive === "pair" ? pair : lone
      if (path === "/latest.txt") return new Response(`v${version}`)
      if (path === `/releases/v${version}/${archiveName}`) return new Response(served.bytes)
      if (path === `/releases/v${version}/${archiveName}.sha256`) {
        const digest = corruptChecksum ? "0".repeat(64) : served.checksum
        return new Response(`${digest}  ${archiveName}\n`)
      }
      return new Response("not found", { status: 404 })
    },
  })

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`
    const publishedSetup = join(tempDirectory, "published-setup.sh")
    const setupSource = await readFile(join(ROOT, "setup.sh"), "utf8")
    await writeFile(publishedSetup, setupSource.replaceAll("__FMX_RELEASE_BASE_URL__", baseUrl))
    const installDirectory = join(tempDirectory, "verified", "bin")
    const installed = await runSetup(undefined, installDirectory, publishedSetup)
    expect(installed.code).toBe(0)
    expect(installed.stdout).toContain(`Installed fmx ${version} at ${installDirectory}/fmx, with its companion fmx-zmx (${companionBuild}) beside it`)
    expect(await readFile(join(installDirectory, "fmx"), "utf8")).toContain(version)
    expect(await readFile(join(installDirectory, "fmx-zmx"), "utf8")).toContain(companionBuild)
    // Nothing but the pair: no temp file survived the renames.
    expect((await readdir(installDirectory)).sort()).toEqual(["fmx", "fmx-zmx"])
    // Installing touched no directory of the user's: the companion's `version` ran in the installer's own.
    expect(await Bun.file(join(tempDirectory, "zmx")).exists()).toBe(false)

    corruptChecksum = true
    const rejectedDirectory = join(tempDirectory, "rejected", "bin")
    const rejected = await runSetup(baseUrl, rejectedDirectory)
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain("SHA-256 mismatch")
    expect(await Bun.file(join(rejectedDirectory, "fmx")).exists()).toBe(false)
    expect(await Bun.file(join(rejectedDirectory, "fmx-zmx")).exists()).toBe(false)

    // An archive with no companion is not a release: nothing is placed, not even fmx.
    corruptChecksum = false
    archive = "lone"
    const loneDirectory = join(tempDirectory, "lone", "bin")
    const refused = await runSetup(baseUrl, loneDirectory)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("does not contain an executable fmx-zmx companion")
    expect(await Bun.file(join(loneDirectory, "fmx")).exists()).toBe(false)
    expect(await Bun.file(join(loneDirectory, "fmx-zmx")).exists()).toBe(false)

    // Over an existing install, a refused archive leaves the old pair exactly as it was.
    const installedFmx = await readFile(join(installDirectory, "fmx"))
    const installedCompanion = await readFile(join(installDirectory, "fmx-zmx"))
    const overExisting = await runSetup(baseUrl, installDirectory)
    expect(overExisting.code).toBe(1)
    expect(Buffer.compare(await readFile(join(installDirectory, "fmx")), installedFmx)).toBe(0)
    expect(Buffer.compare(await readFile(join(installDirectory, "fmx-zmx")), installedCompanion)).toBe(0)
    expect((await readdir(installDirectory)).sort()).toEqual(["fmx", "fmx-zmx"])

    // A directory where an executable must go is refused before anything is placed.
    archive = "pair"
    const blockedDirectory = join(tempDirectory, "blocked", "bin")
    await mkdir(join(blockedDirectory, "fmx-zmx"), { recursive: true })
    const blocked = await runSetup(baseUrl, blockedDirectory)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain(`${blockedDirectory}/fmx-zmx exists and is not a regular file`)
    expect(await Bun.file(join(blockedDirectory, "fmx")).exists()).toBe(false)

    // A companion that cannot report its build is said so, not swallowed by errexit.
    await writeFile(join(payloadDirectory, "fmx-zmx"), "#!/bin/sh\necho 'illegal hardware instruction' >&2\nexit 134\n")
    const crashing = await pack(["fmx", "fmx-zmx", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    pair.bytes = crashing.bytes
    pair.checksum = crashing.checksum
    const unreported = await runSetup(baseUrl, join(tempDirectory, "crashing", "bin"))
    expect(unreported.code).toBe(1)
    expect(unreported.stderr).toContain("downloaded companion did not report its build: illegal hardware instruction")
  } finally {
    server.stop(true)
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

async function runSetup(
  releaseBaseUrl: string | undefined,
  installDirectory: string,
  setupPath = join(ROOT, "setup.sh"),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    FMX_INSTALL_DIR: installDirectory,
    FMX_RELEASE_BASE_URL: releaseBaseUrl,
  }
  if (releaseBaseUrl === undefined) delete env.FMX_RELEASE_BASE_URL

  const child = Bun.spawn(["bash", setupPath], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
