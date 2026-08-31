import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureLifecycleMessageSchema,
  fxLaunchAdmissionFinalMessageSchema,
} from "../src/agentworkplace-contracts.ts"
import {
  CONTRACT_FRAME_HEADER_BYTES,
  CONTRACT_MAX_FRAME_BYTES,
  encodeCanonicalJson,
  type JsonValue,
} from "../src/contract-codec.ts"
import { deriveEnsureDigest } from "../src/ensure-lifecycle-ledger.ts"
import {
  INLINE_INITIAL_WORK_MAX_BYTES,
  INLINE_LAUNCH_CONTROLS_MAX_BYTES,
  INLINE_REMAINING_GLOBAL_ARG_MAX_BYTES,
  INLINE_REMAINING_GLOBAL_ARGS_MAX_COUNT,
  INLINE_LAUNCH_SOURCE_SCHEMA_ID,
  INLINE_LAUNCH_SOURCE_SCHEMA_VERSION,
  InlineLaunchSourceError,
  InlineLaunchSourceLedger,
  authorityFor,
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineLaunchControls,
  encodeInlineSourceBytes,
  inlineLaunchSourceRecordPath,
  parseInlineLaunchControls,
  parseInlineLaunchSourceRequest,
  type FrozenEnsureRequest,
  type FrozenLaunchRequest,
  type InlineLaunchSourceErrorCode,
  type InlineLaunchSourceFaultPoint,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"

const CONTRACT_ROOT = join(import.meta.dir, "../contracts/agentworkplace/v1")
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe("inline-v2 source validation", () => {
  test("verifies every digest and preserves fatal-valid UTF-8 and canonical control bytes exactly", async () => {
    const initialWork = Uint8Array.of(
      0xef, 0xbb, 0xbf,
      ...Buffer.from("line one\r\nline two\nλ", "utf8"),
    )
    const controls = encodeInlineLaunchControls([
      "--no-default-skills",
      "--skills-dir",
      "/tmp/Worker λ",
      "--tool=read_file",
    ])
    expect(Buffer.from(controls).toString("utf8")).toBe(
      '{"remaining_global_args":["--no-default-skills","--skills-dir","/tmp/Worker λ","--tool=read_file"]}',
    )
    const { request } = await sourceFixture({ initialWork, controls })
    expect(request.launch_request.remaining_launch_controls_digest).toBe(
      createHash("sha256").update(controls).digest("hex"),
    )
    expect(parseInlineLaunchSourceRequest(request)).toEqual(request)

    const root = await temporaryDirectory("source-authority-")
    const ledger = await InlineLaunchSourceLedger.open(root)
    const record = await ledger.claim(request)
    expect(record.revision).toBe(1)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    const recordPath = inlineLaunchSourceRecordPath(root, request.source_id)
    expect((await lstat(recordPath)).mode & 0o777).toBe(0o600)
    const stored = await readFile(recordPath)
    expect(stored.at(-1)).toBe(0x0a)
    expect(stored.subarray(0, -1)).toEqual(Buffer.from(
      encodeCanonicalJson(JSON.parse(stored.toString("utf8"))),
    ))

    const retrieved = await ledger.retrieve(authorityFor(request))
    expect(retrieved.initialWork).toEqual(initialWork)
    expect(retrieved.launchControls).toEqual(controls)
    expect(await ledger.inspect(authorityFor(request))).toMatchObject({
      source_id: request.source_id,
      ensure_bound: false,
      initial_work_byte_length: initialWork.byteLength,
      launch_controls_byte_length: controls.byteLength,
    })
  })

  test("rejects noncanonical bytes, length/digest drift, and launch/source correlation without content diagnostics", async () => {
    const invalidUtf8 = Buffer.from("private-invalid-byte-ff", "utf8").toString("base64")
    const cases: Array<[string, (request: InlineLaunchSourceRequest) => void, InlineLaunchSourceErrorCode]> = [
      ["noncanonical base64", (request) => {
        request.initial_work.data = `${request.initial_work.data}\n`
      }, "invalid_request"],
      ["wrong length", (request) => request.initial_work.byte_length++, "invalid_request"],
      ["wrong initial digest", (request) => request.initial_work.sha256 = "f".repeat(64), "invalid_request"],
      ["invalid UTF-8", (request) => {
        const bytes = Uint8Array.of(0xff)
        request.initial_work = encodeInlineSourceBytes(bytes)
        request.launch_request.initial_work_digest = request.initial_work.sha256
        request.launch_request.launch_digest = deriveFrozenLaunchDigest(request.launch_request)
        request.launch_digest = request.launch_request.launch_digest
        request.source_digest = deriveInlineLaunchSourceDigest(request)
      }, "invalid_request"],
      ["NUL initial work", (request) => {
        const bytes = Uint8Array.of(0x61, 0, 0x62)
        request.initial_work = encodeInlineSourceBytes(bytes)
        request.launch_request.initial_work_digest = request.initial_work.sha256
        request.launch_request.launch_digest = deriveFrozenLaunchDigest(request.launch_request)
        request.launch_digest = request.launch_request.launch_digest
        request.source_digest = deriveInlineLaunchSourceDigest(request)
      }, "invalid_request"],
      ["noncanonical controls", (request) => {
        replaceControls(request, Buffer.from('{ "remaining_global_args":[]}', "utf8"))
      }, "invalid_request"],
      ["duplicate control key", (request) => {
        replaceControls(request, Buffer.from('{"remaining_global_args":[],"remaining_global_args":[]}', "utf8"))
      }, "invalid_request"],
      ["launch id drift", (request) => request.launch_id = "foreign-launch", "correlation_mismatch"],
      ["launch digest drift", (request) => request.launch_request.launch_digest = "f".repeat(64), "correlation_mismatch"],
      ["source digest drift", (request) => request.source_digest = "f".repeat(64), "invalid_request"],
    ]

    for (const [label, mutate, code] of cases) {
      const { request } = await sourceFixture()
      mutate(request)
      try {
        parseInlineLaunchSourceRequest(request)
        throw new Error(`${label} unexpectedly parsed`)
      } catch (error) {
        expect(error, label).toBeInstanceOf(InlineLaunchSourceError)
        expect((error as InlineLaunchSourceError).code, label).toBe(code)
        expect((error as Error).message, label).not.toContain(request.initial_work.data)
        expect((error as Error).message, label).not.toContain(invalidUtf8)
      }
    }
  })

  test("accepts exact byte maxima and refuses either decoded bound above it", async () => {
    const maximum = await sourceFixture({
      initialWork: new Uint8Array(INLINE_INITIAL_WORK_MAX_BYTES).fill(0x61),
      controls: maximumControls(),
    })
    expect(parseInlineLaunchSourceRequest(maximum.request).initial_work.byte_length)
      .toBe(INLINE_INITIAL_WORK_MAX_BYTES)
    expect(maximum.request.launch_controls.byte_length).toBe(INLINE_LAUNCH_CONTROLS_MAX_BYTES)
    expect(encodeCanonicalJson(maximum.request as unknown as JsonValue).byteLength + CONTRACT_FRAME_HEADER_BYTES)
      .toBeLessThanOrEqual(CONTRACT_MAX_FRAME_BYTES)
    const maximumRoot = await temporaryDirectory("source-maximum-")
    const maximumLedger = await InlineLaunchSourceLedger.open(maximumRoot)
    await maximumLedger.claim(maximum.request)
    await maximumLedger.bindEnsureRequest(authorityFor(maximum.request), maximum.ensure)
    expect((await lstat(inlineLaunchSourceRecordPath(maximumRoot, maximum.request.source_id))).size)
      .toBeLessThanOrEqual(CONTRACT_MAX_FRAME_BYTES)

    for (const field of ["initial_work", "launch_controls"] as const) {
      const { request } = await sourceFixture()
      const maximumBytes = field === "initial_work"
        ? INLINE_INITIAL_WORK_MAX_BYTES
        : INLINE_LAUNCH_CONTROLS_MAX_BYTES
      const bytes = new Uint8Array(maximumBytes + 1).fill(field === "initial_work" ? 0x61 : 0x31)
      request[field] = encodeInlineSourceBytes(bytes)
      if (field === "initial_work") request.launch_request.initial_work_digest = request[field].sha256
      else request.launch_request.remaining_launch_controls_digest = request[field].sha256
      request.launch_request.launch_digest = deriveFrozenLaunchDigest(request.launch_request)
      request.launch_digest = request.launch_request.launch_digest
      request.source_digest = deriveInlineLaunchSourceDigest(request)
      await expectSourceError(Promise.resolve().then(() => parseInlineLaunchSourceRequest(request)), "invalid_request")
    }
  })

  test("allows only the documented global-argument suffix and preserves every accepted string exactly", () => {
    const valid: readonly string[][] = [
      [],
      ["--record"],
      ["--no-default-skills", "--skills-dir", "/tmp/team λ"],
      ["--append-system-prompt-file=/tmp/role.md", "--tool", "read_file"],
      ["--context-limit=tool=4096", "--add-dir", "/tmp/extra", "--no-additional-dirs"],
      ["--no-native-tools", "--no-project-instructions", "--permissions-file=/tmp/policy.json"],
    ]
    for (const remaining_global_args of valid) {
      const bytes = controlsBytes(remaining_global_args)
      expect(parseInlineLaunchControls(bytes)).toEqual({ remaining_global_args })
    }

    for (let length = 1; length <= 96; length++) {
      const value = `/tmp/${"λ".repeat(length)}`
      const bytes = controlsBytes(["--skills-dir", value])
      expect(parseInlineLaunchControls(bytes).remaining_global_args).toEqual(["--skills-dir", value])
    }
  })

  test("rejects unknown shape, positional/executable injection, provider authority, resume selection, controls, and argv bounds", async () => {
    const invalid: Array<[string, Uint8Array]> = [
      ["unknown field", encodeCanonicalJson({ remaining_global_args: [], unexpected: true })],
      ["wrong field", encodeCanonicalJson({ argv: [] })],
      ["positional executable", rawControlsBytes(["/private/bin/fx"])],
      ["provider state root pair", rawControlsBytes(["--state-dir", "/foreign"])],
      ["provider state root equals", rawControlsBytes(["--state-dir=/foreign"])],
      ["provider conversation name", rawControlsBytes(["--name", "foreign"])],
      ["duplicated model", rawControlsBytes(["--model", "foreign-model"])],
      ["duplicated effort", rawControlsBytes(["--effort=high"])],
      ["resume command", rawControlsBytes(["resume", "foreign-conversation"])],
      ["resume option", rawControlsBytes(["--resume=foreign-conversation"])],
      ["resume alias", rawControlsBytes(["-c"])],
      ["argument separator", rawControlsBytes(["--"])],
      ["unknown global flag", rawControlsBytes(["--future-flag"])],
      ["missing option value", rawControlsBytes(["--skills-dir"])],
      ["ambiguous option value", rawControlsBytes(["--skills-dir", "--name=/foreign"])],
      ["empty equals value", rawControlsBytes(["--tool="])],
      ["ASCII escape", rawControlsBytes(["--skills-dir", "/tmp/line\nnext"])],
      ["ASCII DEL", rawControlsBytes(["--skills-dir", "/tmp/del\u007fpath"])],
      ["too many argv entries", rawControlsBytes(Array.from({ length: INLINE_REMAINING_GLOBAL_ARGS_MAX_COUNT + 1 }, () => "--record"))],
      ["oversized argv entry", rawControlsBytes([`--skills-dir=${"a".repeat(INLINE_REMAINING_GLOBAL_ARG_MAX_BYTES)}`])],
    ]
    for (const [label, controls] of invalid) {
      const { request } = await sourceFixture({ controls })
      await expectSourceError(Promise.resolve().then(() => parseInlineLaunchSourceRequest(request)), "invalid_request")
      expect(() => parseInlineLaunchControls(controls), label).toThrow(InlineLaunchSourceError)
    }
  })
})

describe("inline-v2 durable authority", () => {
  test("makes exact retry idempotent and refuses conflicting source/ensure/launch/admission reuse", async () => {
    const root = await temporaryDirectory("source-retry-")
    const { request } = await sourceFixture()
    let loseResponse = true
    const faulted = await InlineLaunchSourceLedger.open(root, {
      fault: (point) => {
        if (point === "after_commit_before_return" && loseResponse) {
          loseResponse = false
          throw new Error("simulated response loss")
        }
      },
    })
    await expect(faulted.claim(request)).rejects.toThrow("simulated response loss")
    const reopened = await InlineLaunchSourceLedger.open(root)
    expect(await reopened.claim(request)).toMatchObject({ revision: 1, request })

    const changed = structuredClone(request)
    changed.request_id = "changed-request-id"
    await expectSourceError(reopened.claim(changed), "conflicting_claim")

    for (const field of [
      "ensure_id",
      "ensure_digest",
      "worktree_id",
      "agent_id",
      "launch_id",
      "admission_key",
    ] as const) {
      const other = (await sourceFixture({ suffix: field })).request
      other[field] = request[field]
      if (field === "launch_id") {
        other.launch_request.launch_id = request.launch_id
        other.launch_request.launch_digest = deriveFrozenLaunchDigest(other.launch_request)
        other.launch_digest = other.launch_request.launch_digest
      }
      if (field === "admission_key") {
        other.launch_request.admission_key = request.admission_key
        other.launch_request.launch_digest = deriveFrozenLaunchDigest(other.launch_request)
        other.launch_digest = other.launch_request.launch_digest
      }
      other.source_digest = deriveInlineLaunchSourceDigest(other)
      await expectSourceError(reopened.claim(other), "conflicting_claim")
    }
  })

  test("retrieves content only for complete authority and durably binds the matching frozen ensure", async () => {
    const root = await temporaryDirectory("source-bind-")
    const { request, ensure } = await sourceFixture()
    const ledger = await InlineLaunchSourceLedger.open(root)
    await expectSourceError(ledger.bindEnsureRequest(authorityFor(request), ensure), "unauthorized")
    await ledger.claim(request)

    for (const field of ["source_digest", "ensure_id", "launch_digest", "admission_key"] as const) {
      const authority = authorityFor(request)
      authority[field] = field.endsWith("digest") ? "f".repeat(64) : `foreign-${field}`
      await expectSourceError(ledger.retrieve(authority), "unauthorized")
    }

    const mismatched = structuredClone(ensure)
    mismatched.fx_conversation.name = "Foreign conversation"
    mismatched.ensure_digest = deriveEnsureDigest(mismatched)
    const mismatchedAuthority = authorityFor(request)
    mismatchedAuthority.ensure_digest = mismatched.ensure_digest
    await expectSourceError(
      ledger.bindEnsureRequest(mismatchedAuthority, mismatched),
      "unauthorized",
    )

    expect(await ledger.bindEnsureRequest(authorityFor(request), ensure)).toMatchObject({ revision: 2 })
    expect(await ledger.bindEnsureRequest(authorityFor(request), ensure)).toMatchObject({ revision: 2 })
    expect((await ledger.inspect(authorityFor(request))).ensure_bound).toBe(true)

    const changedRequestId = structuredClone(ensure)
    changedRequestId.request_id = "another-ensure-request"
    await expectSourceError(
      ledger.bindEnsureRequest(authorityFor(request), changedRequestId),
      "conflicting_claim",
    )
  })

  for (const operation of ["claim", "bind_ensure"] as const) {
    test(`recovers every ${operation} commit boundary including response loss`, async () => {
      const points: InlineLaunchSourceFaultPoint[] = [
        "before_write",
        "after_file_sync",
        "before_rename",
        "after_rename",
        "after_directory_sync",
        "after_commit_before_return",
      ]
      for (const point of points) {
        const root = await temporaryDirectory(`source-fault-${operation}-${point}-`)
        const { request, ensure } = await sourceFixture({ suffix: `${operation}-${point}` })
        const setup = await InlineLaunchSourceLedger.open(root)
        if (operation === "bind_ensure") await setup.claim(request)
        let injected = false
        const faulted = await InlineLaunchSourceLedger.open(root, {
          fault: (candidate, candidateOperation) => {
            if (!injected && candidate === point && candidateOperation === operation) {
              injected = true
              throw new Error(`crash-${point}`)
            }
          },
        })
        const attempt = operation === "claim"
          ? faulted.claim(request)
          : faulted.bindEnsureRequest(authorityFor(request), ensure)
        await expect(attempt).rejects.toThrow(`crash-${point}`)

        const recovered = await InlineLaunchSourceLedger.open(root)
        const committed = point === "after_rename" || point === "after_directory_sync" ||
          point === "after_commit_before_return"
        if (operation === "claim") {
          if (!committed) {
            await expectSourceError(recovered.retrieve(authorityFor(request)), "unauthorized")
          }
          expect((await recovered.claim(request)).revision).toBe(1)
        } else {
          expect((await recovered.inspect(authorityFor(request))).ensure_bound).toBe(committed)
          expect((await recovered.bindEnsureRequest(authorityFor(request), ensure)).revision).toBe(2)
        }
      }
    })
  }

  test("refuses unsafe roots, record modes, symlinks, hard links, and foreign entries", async () => {
    const parent = await temporaryDirectory("source-storage-")
    const { request } = await sourceFixture()

    const unsafeMode = join(parent, "unsafe-mode")
    const unsafeLedger = await InlineLaunchSourceLedger.open(unsafeMode)
    await unsafeLedger.claim(request)
    const record = inlineLaunchSourceRecordPath(unsafeMode, request.source_id)
    await chmod(record, 0o644)
    await expectSourceError(InlineLaunchSourceLedger.open(unsafeMode), "unsafe_storage")

    const linkRoot = join(parent, "link-root")
    await symlink(unsafeMode, linkRoot)
    await expectSourceError(InlineLaunchSourceLedger.open(linkRoot), "unsafe_storage")

    await chmod(record, 0o600)
    const hardLink = join(unsafeMode, `${"f".repeat(64)}.json`)
    await link(record, hardLink)
    await expectSourceError(InlineLaunchSourceLedger.open(unsafeMode), "unsafe_storage")
    await rm(hardLink)

    const lockPath = join(unsafeMode, ".inline-launch-source.lock")
    await chmod(lockPath, 0o644)
    await expectSourceError(InlineLaunchSourceLedger.open(unsafeMode), "unsafe_storage")
    await chmod(lockPath, 0o600)
    await rm(lockPath)
    await symlink(record, lockPath)
    await expectSourceError(InlineLaunchSourceLedger.open(unsafeMode), "unsafe_storage")

    const foreignRoot = join(parent, "foreign")
    await InlineLaunchSourceLedger.open(foreignRoot)
    await writeFile(join(foreignRoot, "notes.txt"), "foreign\n", { mode: 0o600 })
    await expectSourceError(InlineLaunchSourceLedger.open(foreignRoot), "corrupt_record")
  })
})

async function sourceFixture(options: {
  suffix?: string
  initialWork?: Uint8Array
  controls?: Uint8Array
} = {}): Promise<{
  request: InlineLaunchSourceRequest
  ensure: FrozenEnsureRequest
}> {
  const suffix = options.suffix ?? "a"
  const launchMessages = (await fixtureLines("fx-launch-admission-final.jsonl"))
    .map((value) => fxLaunchAdmissionFinalMessageSchema.parse(value))
  const ensureMessages = (await fixtureLines("ensure-lifecycle.jsonl"))
    .map((value) => ensureLifecycleMessageSchema.parse(value))
  const launch = structuredClone(launchMessages.find(
    (message) => message.message_type === "launch_request",
  )) as FrozenLaunchRequest
  const ensure = structuredClone(ensureMessages.find(
    (message) => message.message_type === "ensure_request",
  )) as FrozenEnsureRequest
  const initialWork = options.initialWork ?? Buffer.from("Private initial work\r\nexact bytes\n", "utf8")
  const controls = options.controls ?? controlsBytes([])
  const initial = encodeInlineSourceBytes(initialWork)
  const launchControls = encodeInlineSourceBytes(controls)

  launch.request_id = `fx-launch-request-${suffix}`
  launch.launch_id = `launch-${suffix}`
  launch.admission_key = `admission-${suffix}`
  launch.initial_work_digest = initial.sha256
  launch.remaining_launch_controls_digest = launchControls.sha256
  launch.launch_digest = deriveFrozenLaunchDigest(launch)

  ensure.request_id = `ensure-request-${suffix}`
  ensure.ensure_id = `ensure-${suffix}`
  ensure.worktree_id = `worktree-${suffix}`
  ensure.agent_id = sha256(`agent-${suffix}`).slice(0, 32)
  ensure.launch_id = launch.launch_id
  ensure.launch_digest = launch.launch_digest
  ensure.planned_worktree.directory = launch.directory
  ensure.fx_conversation.name = launch.conversation_name
  ensure.fx_conversation.resume_conversation_id = launch.resume.mode === "exact"
    ? launch.resume.conversation_id
    : null
  ensure.ensure_digest = deriveEnsureDigest(ensure)

  const request = {
    schema_id: INLINE_LAUNCH_SOURCE_SCHEMA_ID,
    schema_version: INLINE_LAUNCH_SOURCE_SCHEMA_VERSION,
    message_type: "source_request",
    request_id: `source-request-${suffix}`,
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    admission_key: launch.admission_key,
    source_id: `source-${suffix}`,
    source_digest: "0".repeat(64),
    launch_request: launch,
    initial_work: initial,
    launch_controls: launchControls,
  } satisfies InlineLaunchSourceRequest
  request.source_digest = deriveInlineLaunchSourceDigest(request)
  return { request, ensure }
}

function controlsBytes(remaining_global_args: readonly string[]): Uint8Array {
  return encodeInlineLaunchControls(remaining_global_args)
}

function rawControlsBytes(remaining_global_args: readonly string[]): Uint8Array {
  return encodeCanonicalJson({ remaining_global_args: [...remaining_global_args] })
}

function maximumControls(): Uint8Array {
  const prefix = "--append-system-prompt-file="
  const args = Array.from({ length: INLINE_REMAINING_GLOBAL_ARGS_MAX_COUNT }, () => `${prefix}x`)
  let controls = controlsBytes(args)
  let remaining = INLINE_LAUNCH_CONTROLS_MAX_BYTES - controls.byteLength
  for (let index = 0; remaining > 0 && index < args.length; index++) {
    const capacity = INLINE_REMAINING_GLOBAL_ARG_MAX_BYTES - Buffer.byteLength(args[index], "utf8")
    const add = Math.min(capacity, remaining)
    args[index] += "a".repeat(add)
    remaining -= add
  }
  controls = controlsBytes(args)
  expect(controls.byteLength).toBe(INLINE_LAUNCH_CONTROLS_MAX_BYTES)
  return controls
}

function replaceControls(request: InlineLaunchSourceRequest, controls: Uint8Array): void {
  request.launch_controls = encodeInlineSourceBytes(controls)
  request.launch_request.remaining_launch_controls_digest = request.launch_controls.sha256
  request.launch_request.launch_digest = deriveFrozenLaunchDigest(request.launch_request)
  request.launch_digest = request.launch_request.launch_digest
  request.source_digest = deriveInlineLaunchSourceDigest(request)
}

async function fixtureLines(name: string): Promise<JsonValue[]> {
  return (await readFile(join(CONTRACT_ROOT, name), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonValue)
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

async function expectSourceError(
  operation: Promise<unknown>,
  code: InlineLaunchSourceErrorCode,
): Promise<InlineLaunchSourceError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(InlineLaunchSourceError)
    expect((error as InlineLaunchSourceError).code).toBe(code)
    return error as InlineLaunchSourceError
  }
  throw new Error(`expected InlineLaunchSourceError ${code}`)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
