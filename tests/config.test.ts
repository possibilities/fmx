import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  agentDefaultsFor,
  configPath,
  loadConfig,
  workplaceMembershipFor,
} from "../src/config.ts"
import { actionForKey } from "../src/keybindings.ts"
import type { KeyEvent } from "@opentui/core"

test("resolves the XDG config path and explicit override", () => {
  expect(configPath({ XDG_CONFIG_HOME: "/tmp/config" }, "/home/test")).toBe("/tmp/config/fmx/config.toml")
  expect(configPath({}, "/home/test")).toBe("/home/test/.config/fmx/config.toml")
  expect(configPath({ FMX_CONFIG_PATH: "/tmp/fmx.toml" }, "/home/test")).toBe("/tmp/fmx.toml")
})

test("loads a missing config as the default bindings", async () => {
  const loaded = await loadConfig("/definitely/missing/fmx-config.toml")
  expect(loaded.diagnostics).toEqual([])
  expect(loaded.keybindings.prefixLabel).toBe("ctrl+b")
})

test("loads keys from TOML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-"))
  const path = join(directory, "fmx", "config.toml")
  await mkdir(join(directory, "fmx"))
  await writeFile(
    path,
    `[keys]\nprefix = "ctrl+space"\nprevious_tab = ["prefix+p", "alt+1"]\n`,
  )

  try {
    const loaded = await loadConfig(path)
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.keybindings.prefixLabel).toBe("ctrl+space")
    expect(
      actionForKey(
        loaded.keybindings,
        {
          name: "1",
          sequence: "\u001b1",
          raw: "\u001b1",
          ctrl: false,
          shift: false,
          meta: true,
          option: false,
        } as KeyEvent,
        "direct",
      ),
    ).toEqual({ name: "previous_tab" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("loads project roots and diagnoses entries it cannot use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-roots-"))
  const good = join(directory, "roots.toml")
  const bad = join(directory, "bad-roots.toml")
  await writeFile(good, `project_roots = ["~/code", "~/src", "~/code"]\n`)
  await writeFile(bad, `project_roots = ["~/code", 7, ""]\n`)

  try {
    const loaded = await loadConfig(good)
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.projectRoots).toEqual(["~/code", "~/src"])

    const rejected = await loadConfig(bad)
    expect(rejected.projectRoots).toEqual(["~/code"])
    expect(rejected.diagnostics).toEqual([
      "invalid project root: 7; ignoring entry",
      'invalid project root: ""; ignoring entry',
    ])

    expect((await loadConfig("/definitely/missing/fmx-config.toml")).projectRoots).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("loads a worktree root and falls back on one it cannot use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-worktree-"))
  const good = join(directory, "worktree.toml")
  const bad = join(directory, "bad-worktree.toml")
  await writeFile(good, `worktree_root = "~/trees"\n`)
  await writeFile(bad, `worktree_root = 7\n`)

  try {
    expect((await loadConfig(good)).worktreeRoot).toBe("~/trees")
    const rejected = await loadConfig(bad)
    expect(rejected.worktreeRoot).toBe("~/.fmx/worktrees")
    expect(rejected.diagnostics).toEqual([
      "invalid worktree_root: must be a directory; using the default",
    ])
    expect((await loadConfig("/definitely/missing/fmx-config.toml")).worktreeRoot).toBe(
      "~/.fmx/worktrees",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("falls back on malformed TOML and diagnoses unknown keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-errors-"))
  const malformed = join(directory, "malformed.toml")
  const unknown = join(directory, "unknown.toml")
  await writeFile(malformed, "[keys\n")
  await writeFile(
    unknown,
    "[keys]\nclose_tab = \"prefix+q\"\n[theme]\nname = \"terminal\"\n",
  )

  try {
    const malformedConfig = await loadConfig(malformed)
    expect(malformedConfig.keybindings.prefixLabel).toBe("ctrl+b")
    expect(malformedConfig.diagnostics.join("\n")).toContain("config parse error")

    const unknownConfig = await loadConfig(unknown)
    expect(unknownConfig.diagnostics).toContain("unknown config key keys.close_tab; ignoring key")
    expect(unknownConfig.diagnostics).toContain("unknown config section [theme]; ignoring section")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("resolves exact two-member Workplace association and independent Session defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-workplace-"))
  const path = join(directory, "config.toml")
  await writeFile(
    path,
    [
      "[agent_defaults.workers]",
      'state_dir = "~/.local/state/worker"',
      'model = "fixture/model"',
      'effort = "medium"',
      "",
      "[agent_defaults.default]",
      'effort = "high"',
      "",
      "[workplace_instances.personal_software]",
      "schema_version = 1",
      'extension = "agentworkplace"',
      'configuration = "software"',
      "",
      "[workplace_instances.personal_software.role_surfaces]",
      'worker = "workers"',
      'manager = "managers"',
      "",
    ].join("\n"),
  )

  try {
    const loaded = await loadConfig(path, "/Users/example")
    expect(loaded.runtimeConfigurationErrors).toEqual([])
    expect(workplaceMembershipFor(loaded, "workers")).toEqual({
      workplaceInstanceId: "personal_software",
      extensionId: "agentworkplace",
      configurationId: "software",
      placementId: "worker",
      fmxSession: "workers",
      members: [
        { placementId: "manager", fmxSession: "managers" },
        { placementId: "worker", fmxSession: "workers" },
      ],
    })
    expect(workplaceMembershipFor(loaded, "default")).toBeNull()
    expect(agentDefaultsFor(loaded, "workers")).toEqual({
      stateDir: "/Users/example/.local/state/worker",
      model: "fixture/model",
      effort: "medium",
    })
    expect(agentDefaultsFor(loaded, "default")).toEqual({ effort: "high" })
    expect(agentDefaultsFor(loaded, "managers")).toEqual({})
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects invalid association and Agent-default contracts instead of falling back to plain fmx", async () => {
  const cases = [
    {
      name: "one member",
      source: `[workplace_instances.office]\nschema_version = 1\nextension = "ext"\nconfiguration = "cfg"\n[workplace_instances.office.role_surfaces]\none = "alpha"\n`,
      message: "exactly two members",
    },
    {
      name: "same member twice",
      source: `[workplace_instances.office]\nschema_version = 1\nextension = "ext"\nconfiguration = "cfg"\n[workplace_instances.office.role_surfaces]\none = "alpha"\ntwo = "alpha"\n`,
      message: "two distinct",
    },
    {
      name: "unknown association field",
      source: `[workplace_instances.office]\nschema_version = 1\nextension = "ext"\nconfiguration = "cfg"\npolicy = "role"\n[workplace_instances.office.role_surfaces]\none = "alpha"\ntwo = "beta"\n`,
      message: "unknown field policy",
    },
    {
      name: "duplicate membership",
      source: `[workplace_instances.one]\nschema_version = 1\nextension = "ext"\nconfiguration = "a"\n[workplace_instances.one.role_surfaces]\na = "alpha"\nb = "beta"\n[workplace_instances.two]\nschema_version = 1\nextension = "ext"\nconfiguration = "b"\n[workplace_instances.two.role_surfaces]\nc = "alpha"\nd = "gamma"\n`,
      message: "belongs to both",
    },
    {
      name: "relative state directory",
      source: `[agent_defaults.alpha]\nstate_dir = "relative/state"\n`,
      message: "safe absolute or ~/ directory",
    },
    {
      name: "unknown default field",
      source: `[agent_defaults.alpha]\nrole = "worker"\n`,
      message: "unknown field role",
    },
  ] as const
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-invalid-workplace-"))
  try {
    for (const [index, entry] of cases.entries()) {
      const path = join(directory, `${index}.toml`)
      await writeFile(path, entry.source)
      const loaded = await loadConfig(path, "/Users/example")
      expect(loaded.runtimeConfigurationErrors.join("\n"), entry.name).toContain(entry.message)
      expect(() => workplaceMembershipFor(loaded, "alpha"), entry.name).toThrow(
        "invalid Runtime configuration",
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a TOML failure mentioning a new contract fails Runtime resolution while legacy malformed config stays legacy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-malformed-contract-"))
  const contract = join(directory, "contract.toml")
  const legacy = join(directory, "legacy.toml")
  await writeFile(contract, "[workplace_instances.office\n")
  await writeFile(legacy, "[keys\n")
  try {
    expect((await loadConfig(contract)).runtimeConfigurationErrors.join("\n")).toContain("config parse error")
    expect((await loadConfig(legacy)).runtimeConfigurationErrors).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
