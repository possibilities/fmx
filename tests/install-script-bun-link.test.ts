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
  for name in fmx fmx-mcp; do
    dest="\${FAKE_BUN_LINK_DIR}/\${name}"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "\${dest}"
    chmod 0755 "\${dest}"
  done
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

const FAKE_FX_COMMIT = "a".repeat(40)
const FAKE_FXNK_VERSION = "9.9.9"

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
      join(fixtureRoot, "fx.json"),
      JSON.stringify(
        {
          repository: "https://example.invalid/fx.git",
          branch: "integration",
          commit: FAKE_FX_COMMIT,
          fxnk: FAKE_FXNK_VERSION,
        },
        null,
        2,
      ),
      "utf8",
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

    const fakeFxBinary = join(fixtureRoot, "fake-fx")
    await writeExecutable(
      fakeFxBinary,
      `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--fxnk-version" ]]; then\n  printf 'fxnk ${FAKE_FXNK_VERSION} (fx fake)\\n'\n  exit 0\nfi\nexit 0\n`,
    )

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
        FMX_FX_BINARY: fakeFxBinary,
        FMX_FX_COMMIT: FAKE_FX_COMMIT,
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
    expect(stdout).toContain("installed Fx")

    const fmxLink = Bun.file(join(bunLinkDir, "fmx"))
    const fmxMcpLink = Bun.file(join(bunLinkDir, "fmx-mcp"))
    expect(await fmxLink.exists()).toBe(true)
    expect(await fmxMcpLink.exists()).toBe(true)

    const fxInstalled = Bun.file(join(localBinDir, "fmx-fx"))
    const companionInstalled = Bun.file(join(localBinDir, "fmx-zmx"))
    expect(await fxInstalled.exists()).toBe(true)
    expect(await companionInstalled.exists()).toBe(true)
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true })
  }
})
