import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPOSITORY_ROOT = join(import.meta.dir, "..")
const decoder = new TextDecoder()

const FAKE_BUN = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "pm" && "\${2:-}" == "bin" && "\${3:-}" == "-g" ]]; then
  printf 'error: no global package.json (bun pm bin -g requires one)\\n' >&2
  exit 1
fi
if [[ "\${1:-}" == "install" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "link" ]]; then
  mkdir -p "\${FAKE_BUN_LINK_DIR:?}"
  mkdir -p "\${FAKE_BUN_LINK_DIR}"
  dest="\${FAKE_BUN_LINK_DIR}/fmx"
  printf '#!/usr/bin/env bash\\nexit 0\\n' > "\${dest}"
  chmod 0755 "\${dest}"
  exit 0
fi
if [[ "\${1:-}" == *src/index.ts && "\${2:-}" == doctor ]]; then
  exit 0
fi
printf 'fake bun: unhandled invocation: %s\\n' "\$*" >&2
exit 1
`

const FAKE_GIT = `#!/usr/bin/env bash
exit 0
`

const FAKE_ZIG = `#!/usr/bin/env bash
exit 0
`

const FAKE_INSTALL_COMPANION = `#!/usr/bin/env bash
set -euo pipefail
install_dir="\${FMX_COMPANION_INSTALL_DIR:?}"
mkdir -p "\${install_dir}"
dest="\${install_dir}/fmx-zmx"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "\${dest}"
chmod 0755 "\${dest}"
exit 0
`

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8")
  await chmod(path, 0o755)
}

test("installer discovers the bun link directory without bun pm bin -g", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "fmx-install-script-test-"))
  try {
    const fixtureScripts = join(fixtureRoot, "scripts")
    await mkdir(fixtureScripts, { recursive: true })

    const realInstallScript = await readFile(
      join(REPOSITORY_ROOT, "scripts", "install.sh"),
      "utf8",
    )
    await writeExecutable(join(fixtureScripts, "install.sh"), realInstallScript)

    await writeExecutable(
      join(fixtureScripts, "install-companion.sh"),
      FAKE_INSTALL_COMPANION,
    )

    await writeFile(
      join(fixtureRoot, "companion.json"),
      JSON.stringify(
        {
          repository: "https://example.invalid/zmx.git",
          branch: "integration",
          commit: "b".repeat(40),
          build: "0.0.0+fmx.000000000000",
        },
        null,
        2,
      ),
      "utf8",
    )

    const fakeBinDir = join(fixtureRoot, "fake-bin")
    await mkdir(fakeBinDir, { recursive: true })
    await writeExecutable(join(fakeBinDir, "bun"), FAKE_BUN)
    await writeExecutable(join(fakeBinDir, "git"), FAKE_GIT)
    await writeExecutable(join(fakeBinDir, "zig"), FAKE_ZIG)

    const home = join(fixtureRoot, "home")
    const bunInstall = join(fixtureRoot, "bun-install")
    const bunLinkDir = join(bunInstall, "bin")
    await mkdir(home, { recursive: true })

    const localBinDir = join(home, ".local", "bin")

    const result = Bun.spawnSync({
      cmd: [join(fixtureScripts, "install.sh"), "--install"],
      cwd: fixtureRoot,
      env: {
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        HOME: home,
        BUN_INSTALL: bunInstall,
        FAKE_BUN_LINK_DIR: bunLinkDir,
        TMPDIR: fixtureRoot,
      },
      stderr: "pipe",
      stdout: "pipe",
    })

    const stdout = decoder.decode(result.stdout)
    const stderr = decoder.decode(result.stderr)
    expect(stderr).not.toContain("bun pm bin -g")
    if (result.exitCode !== 0) {
      throw new Error(`install.sh failed (${result.exitCode}):\n${stdout}\n${stderr}`)
    }
    expect(stdout).toContain("linked fmx and installed the pinned Companion")

    expect(await Bun.file(join(bunLinkDir, "fmx")).exists()).toBe(true)
    expect(await Bun.file(join(localBinDir, "fmx-zmx")).exists()).toBe(true)
    // fmx installs no program to run inside a Session.
    expect(await Bun.file(join(bunLinkDir, "fmx-mcp")).exists()).toBe(false)
    expect(await Bun.file(join(localBinDir, "fmx-fx")).exists()).toBe(false)
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true })
  }
})
