import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyAgentWorkplaceContracts } from "../scripts/check-agentworkplace-contracts.ts"
import {
  buildFmxProviderManifest,
  canonicalProviderJson,
  FMX_EXPECTED_SKIPS,
  materializeFmxProviderBundle,
  skipSetsMatch,
} from "../scripts/generate-agentworkplace-provider.ts"
import type { JsonValue } from "../src/contract-codec.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe("AgentWorkplace Phase 0 fmx provider adapter", () => {
  test("renders AgentWorkplace canonical provider JSON", () => {
    expect(
      canonicalProviderJson({
        z: ["one", "two"],
        a: { z: true, a: 1 },
      }),
    ).toBe(`{
  "a": {
    "a": 1,
    "z": true
  },
  "z": ["one", "two"]
}
`)
  })

  test("maps every exact owner family and accounts for all 18 skips", async () => {
    const verification = await verifyAgentWorkplaceContracts()
    const manifest = buildFmxProviderManifest({
      actualSkipDescriptions: FMX_EXPECTED_SKIPS.map(
        ({ description }) => description,
      ),
      consumedRuntimeRegistrationDigest:
        "sha256:92a3e113ef3a4fa032da8679eb2631c4f4f8b07ec689a7d260aee92af12733e6",
      gateExitStatus: 0,
      repositorySha: "f".repeat(40),
      verification,
    })
    expect(manifest.contracts.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "fmx.runtime-extension-protocol", kind: "protocol" },
      { id: "fmx.agent-defaults", kind: "schema" },
      { id: "fmx.ensure-lifecycle", kind: "protocol" },
      { id: "fmx.fx-launch-admission", kind: "protocol" },
    ])
    expect(manifest.contracts.map(({ artifacts }) => artifacts[0]?.digest)).toEqual([
      "sha256:0ae7816c752eadf31dfa47651f0e37d64d72d272624046903b9f3519d982b88d",
      "sha256:d9f9858ad5a8593bdb7f8833d23da043b7b364673baaed32d2f24f1db6910265",
      "sha256:97c7bbd64cb81186f2bfc8268be48e6152955d0ed6f2336b4061004df93c93a2",
      "sha256:b807e31bf8f4de4179b91cca4c9f3a9a40d572f98d8e5467242fc70908eb8161",
    ])
    expect(manifest.skips.expected).toHaveLength(18)
    expect(manifest.skips.actual).toEqual(manifest.skips.expected)
    expect(skipSetsMatch(manifest)).toBe(true)
    for (const contract of manifest.contracts) {
      expect(contract.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    }
  })

  test("copies exact committed artifacts and refuses skip drift semantically", async () => {
    const verification = await verifyAgentWorkplaceContracts()
    const manifest = buildFmxProviderManifest({
      actualSkipDescriptions: [],
      consumedRuntimeRegistrationDigest:
        "sha256:92a3e113ef3a4fa032da8679eb2631c4f4f8b07ec689a7d260aee92af12733e6",
      gateExitStatus: 0,
      repositorySha: "e".repeat(40),
      verification,
    })
    expect(skipSetsMatch(manifest)).toBe(false)

    const output = await mkdtemp(join(tmpdir(), "fmx-phase0-provider-"))
    temporaryDirectories.push(output)
    const generated = await materializeFmxProviderBundle(
      output,
      manifest,
      verification,
    )
    expect(generated.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(await readFile(generated.path, "utf8")).toBe(
      canonicalProviderJson(manifest as unknown as JsonValue),
    )
    for (const contract of manifest.contracts) {
      const artifact = contract.artifacts[0]
      expect(artifact).toBeDefined()
      const bytes = await readFile(join(output, artifact!.path))
      expect(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`).toBe(
        artifact!.digest,
      )
    }
  })
})
