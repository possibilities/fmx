import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SUPPORTED_HOST =
  (process.platform === "darwin" || process.platform === "linux") &&
  (process.arch === "arm64" || process.arch === "x64")

test.skipIf(!SUPPORTED_HOST)("setup installs a verified gzip fallback and rejects a bad checksum", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-setup-test-"))
  const payloadDirectory = join(tempDirectory, "payload")
  const releaseDirectory = join(tempDirectory, "release")
  const version = "9.8.7"
  const os = process.platform === "darwin" ? "macos" : "linux"
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
  const archiveName = `fmx-${os}-${arch}.tar.gz`
  const archivePath = join(releaseDirectory, archiveName)
  let corruptChecksum = false

  await mkdir(payloadDirectory)
  await mkdir(releaseDirectory)
  await writeFile(
    join(payloadDirectory, "fmx"),
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\nexit 0\n`,
  )
  await chmod(join(payloadDirectory, "fmx"), 0o755)
  await writeFile(join(payloadDirectory, "LICENSE"), "test license\n")
  await writeFile(join(payloadDirectory, "THIRD_PARTY_NOTICES.md"), "test notices\n")

  const tar = Bun.spawn(
    [
      "tar",
      "-czf",
      archivePath,
      "-C",
      payloadDirectory,
      "fmx",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  expect(await tar.exited).toBe(0)
  const archiveBytes = await Bun.file(archivePath).arrayBuffer()
  const checksum = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex")

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/latest.txt") return new Response(`v${version}`)
      if (path === `/releases/v${version}/${archiveName}`) return new Response(Bun.file(archivePath))
      if (path === `/releases/v${version}/${archiveName}.sha256`) {
        const digest = corruptChecksum ? "0".repeat(64) : checksum
        return new Response(`${digest}  ${archiveName}\n`)
      }
      return new Response("not found", { status: 404 })
    },
  })

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`
    const installDirectory = join(tempDirectory, "verified", "bin")
    const installed = await runSetup(baseUrl, installDirectory)
    expect(installed.code).toBe(0)
    expect(installed.stdout).toContain(`Installed fmx ${version}`)
    expect(await readFile(join(installDirectory, "fmx"), "utf8")).toContain(version)

    corruptChecksum = true
    const rejectedDirectory = join(tempDirectory, "rejected", "bin")
    const rejected = await runSetup(baseUrl, rejectedDirectory)
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain("SHA-256 mismatch")
    expect(await Bun.file(join(rejectedDirectory, "fmx")).exists()).toBe(false)
  } finally {
    server.stop(true)
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

async function runSetup(
  releaseBaseUrl: string,
  installDirectory: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bash", "setup.sh"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FMX_INSTALL_DIR: installDirectory,
      FMX_RELEASE_BASE_URL: releaseBaseUrl,
    },
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
