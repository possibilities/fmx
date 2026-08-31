import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RUNTIME_EXTENSION_CAPABILITIES } from "../src/agentworkplace-contracts.ts"
import {
  loadRuntimeExtensionRegistration,
  parseRuntimeExtensionRegistration,
  runtimeExtensionManifestPath,
  runtimeExtensionRegistrationMessage,
} from "../src/runtime-extension-registration.ts"

const VALID = [
  "schema_version = 1",
  'extension_id = "agentworkplace"',
  'argv = ["/opt/agentworkplace/bin/agentworkplace", "runtime-extension"]',
  "",
  "[protocol]",
  "minimum = 1",
  "maximum = 1",
  "",
  "[capabilities]",
  "headless_liveness = true",
  "",
].join("\n")

test("parses the exact registration and derives the canonical required capabilities", () => {
  const registration = parseRuntimeExtensionRegistration(VALID, "agentworkplace")
  expect(registration).toEqual({
    schemaVersion: 1,
    extensionId: "agentworkplace",
    argv: ["/opt/agentworkplace/bin/agentworkplace", "runtime-extension"],
    protocol: { minimum: 1, maximum: 1 },
    headlessLiveness: true,
  })
  expect(runtimeExtensionRegistrationMessage(registration)).toEqual({
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "registration",
    extension_id: "agentworkplace",
    argv: ["/opt/agentworkplace/bin/agentworkplace", "runtime-extension"],
    protocol: { minimum: 1, maximum: 1 },
    required_capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
  })
})

test("registration validation fails closed for owner-contract violations", () => {
  const invalid = [
    ["mismatched id", VALID.replace('extension_id = "agentworkplace"', 'extension_id = "other"'), "must match"],
    ["relative argv", VALID.replace("/opt/agentworkplace/bin/agentworkplace", "agentworkplace"), "absolute normalized"],
    ["root argv", VALID.replace("/opt/agentworkplace/bin/agentworkplace", "/"), "absolute normalized"],
    ["inverted range", VALID.replace("minimum = 1\nmaximum = 1", "minimum = 2\nmaximum = 1"), "must not exceed"],
    ["unsupported range", VALID.replace("minimum = 1\nmaximum = 1", "minimum = 2\nmaximum = 2"), "does not include"],
    ["headless disabled", VALID.replace("headless_liveness = true", "headless_liveness = false"), "must be true"],
    ["embedded policy", VALID.replace("\n[protocol]", '\nworkplace = "office"\n\n[protocol]'), "unknown field workplace"],
  ] as const
  for (const [name, source, message] of invalid) {
    expect(() => parseRuntimeExtensionRegistration(source, "agentworkplace"), name).toThrow(message)
  }
})

test("resolves only the explicitly named manifest below the fmx configuration root", async () => {
  const root = await mkdtemp(join(tmpdir(), "fmx-runtime-registration-"))
  const path = runtimeExtensionManifestPath(root, "agentworkplace")
  await mkdir(join(root, "runtime-extensions"))
  await writeFile(path, VALID)
  await writeFile(join(root, "runtime-extensions", "unrelated.toml"), VALID)
  try {
    expect(await loadRuntimeExtensionRegistration(root, "agentworkplace")).toMatchObject({
      extensionId: "agentworkplace",
    })
    await expect(loadRuntimeExtensionRegistration(root, "missing")).rejects.toThrow(
      "cannot read Runtime-extension registration",
    )
    expect(() => runtimeExtensionManifestPath(root, "../escape")).toThrow("invalid extension id")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
