import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { resolveFmxHome } from "../src/home.ts"
import {
  decodeRuntimeStartupSnapshot,
  encodeRuntimeStartupSnapshot,
  resolveRuntimeStartupSnapshot,
  runtimeStartupEnvironment,
  RUNTIME_STARTUP_SNAPSHOT_ENV_VAR,
} from "../src/runtime-startup.ts"

test("cold-start resolution freezes exact association, registration, placement, and defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "fmx-runtime-startup-"))
  const configRoot = join(root, "fmx")
  const configPath = join(configRoot, "config.toml")
  await mkdir(join(configRoot, "runtime-extensions"), { recursive: true })
  await writeFile(
    configPath,
    `[agent_defaults.workers]\nstate_dir = "~/.state/workers"\nmodel = "fixture/model"\n\n[workplace_instances.office]\nschema_version = 1\nextension = "fixture-extension"\nconfiguration = "fixture-configuration"\n\n[workplace_instances.office.role_surfaces]\nalpha = "managers"\nbeta = "workers"\n`,
  )
  await writeFile(
    join(configRoot, "runtime-extensions", "fixture-extension.toml"),
    `schema_version = 1\nextension_id = "fixture-extension"\nargv = ["/opt/fmx-fixtures/bin/runtime-extension", "serve"]\n\n[protocol]\nminimum = 1\nmaximum = 1\n\n[capabilities]\nheadless_liveness = true\n`,
  )
  try {
    const homeDirectory = join(root, "home")
    const home = resolveFmxHome("workers", { XDG_CONFIG_HOME: root }, homeDirectory)
    const config = await loadConfig(configPath, homeDirectory)
    const startup = await resolveRuntimeStartupSnapshot(config, home)
    expect(startup).toMatchObject({
      schemaVersion: 1,
      fmxSession: "workers",
      agentDefaults: {
        stateDir: join(homeDirectory, ".state", "workers"),
        model: "fixture/model",
      },
      runtimeExtension: {
        placementId: "beta",
        association: {
          workplace_instance_id: "office",
          extension_id: "fixture-extension",
          configuration_id: "fixture-configuration",
          members: [
            { placement_id: "alpha", fmx_session: "managers" },
            { placement_id: "beta", fmx_session: "workers" },
          ],
        },
        registration: {
          argv: ["/opt/fmx-fixtures/bin/runtime-extension", "serve"],
        },
      },
    })
    const encoded = encodeRuntimeStartupSnapshot(startup)
    expect(decodeRuntimeStartupSnapshot(encoded, "workers")).toEqual(startup)
    expect(runtimeStartupEnvironment(startup)).toEqual({
      [RUNTIME_STARTUP_SNAPSHOT_ENV_VAR]: encoded,
    })
    expect(() => decodeRuntimeStartupSnapshot(encoded, "managers")).toThrow("expected managers")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an unassociated Session freezes independent defaults without resolving any manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "fmx-runtime-startup-plain-"))
  const configPath = join(root, "config.toml")
  await writeFile(configPath, `[agent_defaults.default]\neffort = "max"\n`)
  try {
    const home = resolveFmxHome(null, { XDG_CONFIG_HOME: root }, join(root, "home"))
    const config = await loadConfig(configPath, join(root, "home"))
    expect(await resolveRuntimeStartupSnapshot(config, home)).toEqual({
      schemaVersion: 1,
      fmxSession: "default",
      agentDefaults: { effort: "max" },
      runtimeExtension: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("startup snapshot decoding rejects noncanonical or identity-inconsistent authority", async () => {
  const snapshot = {
    schemaVersion: 1 as const,
    fmxSession: "alpha",
    agentDefaults: {},
    runtimeExtension: null,
  }
  const encoded = encodeRuntimeStartupSnapshot(snapshot)
  expect(() => decodeRuntimeStartupSnapshot(` ${encoded}`)).toThrow()
  expect(() => decodeRuntimeStartupSnapshot(encoded.replace('"alpha"', '"bad session"'))).toThrow(
    "invalid fmx Session",
  )
})
