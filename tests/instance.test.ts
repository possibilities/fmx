import { expect, test } from "bun:test"
import { join } from "node:path"
import {
  DEFAULT_INSTANCE_NAME,
  instanceIdFor,
  InvalidInstanceNameError,
  normalizeInstanceName,
  resolveInstance,
} from "../src/instance.ts"
import { apiSocketPathFor } from "../src/api-server.ts"
import { runtimeSessionName, sessionIdentity } from "../src/session-identity.ts"

test("plain fmx is the default Instance and names select independent ones", () => {
  expect(normalizeInstanceName(null)).toBe(DEFAULT_INSTANCE_NAME)
  expect(normalizeInstanceName("default")).toBe("default")
  expect(normalizeInstanceName("review")).toBe("review")
  expect(() => normalizeInstanceName("Review")).toThrow(InvalidInstanceNameError)
})

test("an Instance id is derived from its name, never stored", () => {
  expect(instanceIdFor("default")).toMatch(/^[0-9a-f]{12}$/u)
  expect(instanceIdFor("default")).toBe(instanceIdFor("default"))
  expect(instanceIdFor("review")).not.toBe(instanceIdFor("default"))
})

test("every Instance reads the one shared configuration", () => {
  const env = { XDG_CONFIG_HOME: "/tmp/config" }
  const base = resolveInstance(null, env, "/home/test")
  const named = resolveInstance("review", env, "/home/test")
  expect(base.configPath).toBe(join("/tmp/config", "fmx", "config.toml"))
  expect(named.configPath).toBe(base.configPath)
  expect(named.id).not.toBe(base.id)
  expect(base.name).toBe("default")
  expect(named.name).toBe("review")
})

test("an Instance's private names all key off its id", () => {
  const instance = resolveInstance("review", { XDG_CONFIG_HOME: "/tmp/config" }, "/home/test")
  expect(apiSocketPathFor(instance.id, 501)).toBe(`/tmp/fmx-501/${instance.id}.api`)
  expect(runtimeSessionName(instance.id)).toBe(`fmxr-${instance.id}`)
  expect(sessionIdentity(instance.id, "tray").companionName).toBe(`fmx-${instance.id}-tray`)
})
