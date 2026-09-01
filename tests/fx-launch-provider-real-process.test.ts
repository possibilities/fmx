import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  writeFile,
} from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createFxEnvironment } from "../src/fx-environment.ts"
import {
  encodeLaunchControls,
  FxLaunchProviderClient,
  type FxLaunchRequest,
} from "../src/fx-launch-provider.ts"
import {
  deriveFrozenLaunchDigest,
  type FrozenLaunchRequest,
} from "../src/inline-launch-source.ts"

const ENABLED = process.env.FMX_RUN_FX_LAUNCH_PROVIDER_REAL_PROCESS === "1"
const SKIP_CONTRACT =
  "the exact Fx supplier and private launch provider prove process-only auto under ambient yolo (explicit opt-in only)"

const FMX_CONSUMER_COMMIT = "8f12d0384987c4f6024759b2edfe097ee6b11914"
const FMX_CONSUMER_TREE = "8e61019b5476d61902b57026f5060402d8489463"
const FX_SUPPLIER_REPOSITORY = "/Volumes/Scratch/fx-phase2-permission-mode.CV8gke/worktree"
const FX_SUPPLIER_COMMIT = "9ba167350abe035957aec07411b3a327371e3275"
const FX_SUPPLIER_TREE = "7eb83bd94e8e10f0f6658207aa2c1ebe6ea68bb5"
const FX_SUPPLIER_PARENTS = [
  "2b88952d123868c36407ef284917ad3e0522ee2f",
  "ed0b75e490a63263149918e7d3af95470768aa2c",
  "4891175d1a3e0e914a89f10309a53d257c0eb5a7",
] as const
const FX_PERMISSION_CARRY_PARENT = "6f44cd94d3f4b0a0516bd14bfaa20bdac3200717"
const FX_HOSTED_CARRY = "4891175d1a3e0e914a89f10309a53d257c0eb5a7"
const FX_UPSTREAM_BASE = "766e70f0106393b551e2363526cf6a41e60587c3"
const FX_HOSTED_CARRY_PATH = ".github/workflows/full-ci.yml"
const FX_BINARY_SHA256 = "17fbc6f5a6fc8c00e6e2c628b1d8a4ab39682efaafb1b1e1d55c745bdcaff6e2"
const FX_BINARY_SIZE = 11_114_368
const FX_BINARY_PATH =
  `/Volumes/Scratch/fx-phase2-permission-mode.CV8gke/artifacts/${FX_SUPPLIER_COMMIT}/${FX_BINARY_SHA256}/fx`
const FX_VERSION = "0.0.7"
const FX_BUILD_REVISION = FX_SUPPLIER_COMMIT.slice(0, 12)
const FX_FILE_DESCRIPTION = "Mach-O 64-bit executable arm64"

const EVIDENCE_ROOT = "/Volumes/Scratch/fx-phase2-permission-mode.CV8gke/proof/permission-run-maOw2l"
const WORKSPACE = join(EVIDENCE_ROOT, "workspace")
const SETTINGS_SHA256 = "f548475c050dcf888b1c5df2da7473c1784eee6551ada1a6e7066a921fdb5f74"
const SETTINGS_BYTES = `${JSON.stringify({
  permission_mode: "yolo",
  workspaces: { [WORKSPACE]: { permission_mode: "yolo" } },
  permission: {},
  sandbox: "none",
  session_naming: { gateway: null, codex: null, grok: null },
})}\n`

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))
const TEST_PATH = "tests/fx-launch-provider-real-process.test.ts"
const WAIT_MS = 15_000
const MAX_TERMINAL_BYTES = 16 * 1024 * 1024

test("pins the exact Phase 2 supplier and yolo fixture bytes", () => {
  expect(Buffer.byteLength(SETTINGS_BYTES)).toBe(251)
  expect(sha256(SETTINGS_BYTES)).toBe(SETTINGS_SHA256)
  expect(FX_BINARY_PATH).toContain(`/${FX_SUPPLIER_COMMIT}/${FX_BINARY_SHA256}/fx`)
  expect(FX_SUPPLIER_PARENTS[2]).toBe(FX_HOSTED_CARRY)
  expect(WORKSPACE).toBe(
    "/Volumes/Scratch/fx-phase2-permission-mode.CV8gke/proof/permission-run-maOw2l/workspace",
  )
})

test("constructs one minimal proof environment without ambient credentials", () => {
  const environment = isolatedEnvironment("/private/fmx-phase2-proof-home")
  expect(Object.keys(environment).sort()).toEqual([
    "COLORTERM",
    "FX_AUTO_UPGRADE",
    "FX_DISABLE_KEYCHAIN",
    "FX_EFFORT",
    "FX_MODEL",
    "FX_PERMISSION_MODE",
    "FX_SKIP_ONBOARDING",
    "HOME",
    "LANG",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
  ])
  for (const forbidden of [
    "AI_GATEWAY_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "SSH_AUTH_SOCK",
    "VERCEL_OIDC_TOKEN",
  ]) {
    expect(environment[forbidden]).toBeUndefined()
  }
})

test("accepts only a post-boundary marker retained on the final visible VT screen", () => {
  const marker = "● Permissions: mode=auto"
  const before = Buffer.from(`\u001b[2J\u001b[2;1H${marker}`)
  const preBoundary = VtVisibleScreen.fromBytes(before, before.byteLength, 80, 8)
  expect(preBoundary.hasVisibleLineAfter(marker)).toBe(false)

  const erasedBytes = Buffer.from(`\u001b[2J\u001b[2;1H${marker}\r\u001b[2K`)
  const erased = VtVisibleScreen.fromBytes(erasedBytes, 0, 80, 8)
  expect(erased.hasVisibleLineAfter(marker)).toBe(false)

  const concealedBytes = Buffer.from(`\u001b[2J\u001b[2;1H\u001b[8m${marker}\u001b[28m`)
  const concealed = VtVisibleScreen.fromBytes(concealedBytes, 0, 80, 8)
  expect(concealed.hasVisibleLineAfter(marker)).toBe(false)

  const pendingSync = Buffer.from(`\u001b[2J\u001b[?2026h\u001b[2;1H${marker}`)
  expect(VtVisibleScreen.fromBytes(pendingSync, 0, 80, 8).hasVisibleLineAfter(marker)).toBe(false)

  const after = Buffer.from(`\u001b[2;1H${marker}\u001b[?2026l`)
  const complete = Buffer.concat([before, Buffer.from("\u001b[2K\u001b[?2026h"), after])
  const visible = VtVisibleScreen.fromBytes(complete, before.byteLength, 80, 8)
  expect(visible.hasVisibleLineAfter(marker)).toBe(true)
  expect(visible.text()).toContain(marker)
})

test("fails closed when the one retained terminal capture exceeds its byte bound", () => {
  const capture = new BoundedTerminalCapture(4)
  capture.append(Buffer.from("abc"))
  const boundary = capture.markBoundary()
  expect(boundary).toBe(3)
  capture.append(Buffer.from("de"))
  expect(capture.overflowed).toBe(true)
  expect(capture.retainedBytes().toString("utf8")).toBe("abc")
  expect(() => capture.bytes()).toThrow("terminal capture exceeded 4 bytes")
})

test.skipIf(!ENABLED)(SKIP_CONTRACT, async () => {
  requireExactEnvironment("FMX_FX_PATH", FX_BINARY_PATH)
  requireExactEnvironment("FMX_PHASE2_PERMISSION_EVIDENCE_ROOT", EVIDENCE_ROOT)
  await assertFreshPrivateRoot(EVIDENCE_ROOT)

  const stateRoot = join(EVIDENCE_ROOT, "state")
  const settingsDirectory = join(stateRoot, ".fx")
  const settingsPath = join(settingsDirectory, "settings.json")
  const ambientHome = join(EVIDENCE_ROOT, "ambient-home")
  const identityHome = join(EVIDENCE_ROOT, "identity-home")
  const providerRuntime = `/tmp/fmx-p2-permission-${process.getuid!()}`
  const stderrPath = join(EVIDENCE_ROOT, "stderr.log")
  const directories = [WORKSPACE, stateRoot, settingsDirectory, ambientHome, identityHome]
  for (const path of directories) await mkdir(path, { recursive: true, mode: 0o700 })
  for (const path of directories) await assertPrivateDirectory(path)
  await assertPathAbsent(providerRuntime)
  await mkdir(providerRuntime, { mode: 0o700 })
  await assertPrivateDirectory(providerRuntime)
  await writeFile(settingsPath, SETTINGS_BYTES, { encoding: "utf8", mode: 0o600, flag: "wx" })
  await writeFile(stderrPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" })

  let child: ReturnType<typeof Bun.spawn> | null = null
  let terminal: Bun.Terminal | null = null
  const terminalCapture = new BoundedTerminalCapture(MAX_TERMINAL_BYTES)

  try {
    const fmx = await verifyFmxSource()
    const supplier = await verifySupplier(identityHome)
    const settingsBefore = await readFile(settingsPath)
    expect(settingsBefore.byteLength).toBe(251)
    expect(sha256(settingsBefore)).toBe(SETTINGS_SHA256)
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600)
    await writePrivate(join(EVIDENCE_ROOT, "settings.before.json"), settingsBefore)
    await writeJson(join(EVIDENCE_ROOT, "supplier.json"), { fmx, supplier })

    const controls = ["--permission-mode", "auto"] as const
    const launchControls = encodeLaunchControls(controls)
    const remainingLaunchControlsDigest = sha256(launchControls)
    const initialWorkDigest = sha256("PHASE2_PERMISSION_MODE_REAL_PROCESS_PROOF\n")
    const launchRequest: FrozenLaunchRequest = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "launch_request",
      request_id: "phase2-permission-prepare",
      launch_id: "phase2-permission-launch",
      launch_digest: "0".repeat(64),
      admission_key: "phase2-permission-admission",
      conversation_name: "Phase 2 permission authority proof",
      resume: { mode: "fresh" },
      state_root: stateRoot,
      directory: WORKSPACE,
      initial_work_digest: initialWorkDigest,
      remaining_launch_controls_digest: remainingLaunchControlsDigest,
    }
    launchRequest.launch_digest = deriveFrozenLaunchDigest(launchRequest)

    const parentEnvironment = isolatedEnvironment(ambientHome)
    const provider = new FxLaunchProviderClient({
      executable: FX_BINARY_PATH,
      runtimeDirectory: providerRuntime,
      timeoutMs: WAIT_MS,
      parentEnvironment,
    })
    const launchReceipt = await provider.prepare(launchRequest as FxLaunchRequest)
    expect(launchReceipt).toMatchObject({
      request_id: launchRequest.request_id,
      launch_id: launchRequest.launch_id,
      launch_digest: launchRequest.launch_digest,
      admission_key: launchRequest.admission_key,
      status: "accepted",
    })
    const invocation = await provider.build({
      stateRoot,
      admissionKey: launchRequest.admission_key,
      launchDigest: launchRequest.launch_digest,
      launchId: launchRequest.launch_id,
      mode: "initial",
      remainingGlobalArgs: controls,
      remainingLaunchControlsDigest,
    })
    expect(invocation.cwd).toBe(WORKSPACE)
    expect(invocation.mode).toBe("initial")
    expect(invocation.command.filter((argument) => argument === "--permission-mode")).toHaveLength(1)
    const permissionIndex = invocation.command.indexOf("--permission-mode")
    expect(invocation.command.slice(permissionIndex, permissionIndex + 2)).toEqual([...controls])
    expect(invocation.command.some((argument) => argument.startsWith("--permission-mode="))).toBe(false)
    expect(invocation.env).toMatchObject({
      FX_INTERNAL_LAUNCH_STATE_ROOT: stateRoot,
      FX_INTERNAL_LAUNCH_ADMISSION_KEY: launchRequest.admission_key,
      FX_INTERNAL_LAUNCH_DIGEST: launchRequest.launch_digest,
      FX_INTERNAL_LAUNCH_ID: launchRequest.launch_id,
      FX_INTERNAL_LAUNCH_CONVERSATION_ID: invocation.conversationId,
    })
    expect(invocation.env.FX_MODEL).toBeUndefined()
    expect(invocation.env.FX_EFFORT).toBeUndefined()
    expect(invocation.env.FX_PERMISSION_MODE).toBeUndefined()
    expect(await readdir(providerRuntime)).toEqual([])
    await writeJson(join(EVIDENCE_ROOT, "provider.json"), {
      launch_request: launchRequest,
      launch_receipt: launchReceipt,
      launch_controls_utf8: launchControls,
      launch_controls_sha256: remainingLaunchControlsDigest,
      build: {
        command: invocation.command,
        cwd: invocation.cwd,
        environment: invocation.env,
        conversation_id: invocation.conversationId,
        mode: invocation.mode,
      },
      ephemeral_runtime: providerRuntime,
    })

    const processParent = { ...parentEnvironment }
    delete processParent.FX_MODEL
    delete processParent.FX_EFFORT
    const processEnvironment = stringEnvironment({
      ...createFxEnvironment(processParent, 1, invocation.cwd),
      ...invocation.env,
    })
    expect(processEnvironment.FX_PERMISSION_MODE).toBe("yolo")
    expect(processEnvironment.FX_MODEL).toBeUndefined()
    expect(processEnvironment.FX_EFFORT).toBeUndefined()
    expect(processEnvironment.HOME).toBe(ambientHome)
    expect(processEnvironment.PWD).toBe(WORKSPACE)

    terminal = new Bun.Terminal({
      cols: 120,
      rows: 40,
      data: (_terminal, bytes) => terminalCapture.append(bytes),
    })
    const wrapper = [
      "/bin/sh",
      "-c",
      'exec "$@" 2>"$0"',
      stderrPath,
      FX_BINARY_PATH,
      ...invocation.command,
    ]
    child = Bun.spawn(wrapper, {
      cwd: invocation.cwd,
      env: processEnvironment,
      terminal,
    })
    const processId = child.pid
    await waitFor(
      () => terminalCapture.screen(120, 40).text().includes("❯"),
      "Fx composer",
    )
    const permissionBoundary = terminalCapture.markBoundary()
    terminal.write("/permissions\r")
    const permissionScreen = await waitForStablePermissionScreen(
      terminalCapture,
      permissionBoundary,
      "● Permissions: mode=auto",
    )
    terminal.write("/quit\r")
    const exitCode = await withTimeout(child.exited, WAIT_MS, "Fx did not exit after /quit")
    terminalCapture.assertWithinBound()
    expect(exitCode).toBe(0)
    expect(child.signalCode).toBeNull()
    terminal.close()
    terminal = null

    const terminalBytes = terminalCapture.bytes()
    const permissionScreenText = permissionScreen.text()
    expect(permissionScreen.hasVisibleLineAfter("● Permissions: mode=auto")).toBe(true)
    expect(permissionScreenText).toContain("● Permissions: mode=auto")
    const stderr = await readFile(stderrPath)
    expect(stderr.byteLength).toBe(0)
    const settingsAfter = await readFile(settingsPath)
    expect(settingsAfter.equals(settingsBefore)).toBe(true)
    expect(sha256(settingsAfter)).toBe(SETTINGS_SHA256)
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600)
    expect(processExists(processId)).toBe(false)
    expect(await readdir(providerRuntime)).toEqual([])

    await writePrivate(join(EVIDENCE_ROOT, "terminal.raw"), terminalBytes)
    await writePrivate(join(EVIDENCE_ROOT, "permission-screen.txt"), `${permissionScreenText}\n`)
    await writePrivate(join(EVIDENCE_ROOT, "settings.after.json"), settingsAfter)
    await writeJson(join(EVIDENCE_ROOT, "process.json"), {
      command: [FX_BINARY_PATH, ...invocation.command],
      wrapper,
      cwd: invocation.cwd,
      inherited_permission_mode: processEnvironment.FX_PERMISSION_MODE,
      explicit_permission_argv: controls,
      model_environment_present: processEnvironment.FX_MODEL !== undefined,
      effort_environment_present: processEnvironment.FX_EFFORT !== undefined,
      pid: processId,
      exit_code: exitCode,
      signal: child.signalCode,
      stderr_bytes: stderr.byteLength,
      stderr_sha256: sha256(stderr),
      terminal_bytes: terminalBytes.byteLength,
      terminal_sha256: sha256(terminalBytes),
      permission_boundary_bytes: permissionBoundary,
      permission_screen_sha256: sha256(`${permissionScreenText}\n`),
      observed_line: "● Permissions: mode=auto",
      inputs: ["/permissions", "/quit"],
      process_reaped: !processExists(processId),
      provider_runtime_empty: (await readdir(providerRuntime)).length === 0,
      settings_before_sha256: sha256(settingsBefore),
      settings_after_sha256: sha256(settingsAfter),
      settings_unchanged: settingsAfter.equals(settingsBefore),
    })

    const artifactAfter = await artifactIdentity(FX_BINARY_PATH)
    expect(artifactAfter).toEqual(supplier.artifact)
    expect((await git(["status", "--porcelain=v1"], FX_SUPPLIER_REPOSITORY)).stdout).toBe("")
    expect((await git(["status", "--porcelain=v1", "--untracked-files=all"], REPOSITORY_ROOT)).stdout)
      .toBe("")
    await rmdir(providerRuntime)
    expect(await pathExists(providerRuntime)).toBe(false)
    const inventory = await evidenceInventory(EVIDENCE_ROOT)
    await writeJson(join(EVIDENCE_ROOT, "evidence.json"), {
      schema_id: "fmx.fx-launch-provider-real-process-evidence",
      schema_version: 1,
      fmx_consumer_commit: FMX_CONSUMER_COMMIT,
      fmx_consumer_tree: FMX_CONSUMER_TREE,
      fmx_harness_commit: fmx.harness_commit,
      fmx_harness_tree: fmx.harness_tree,
      fmx_harness_blob: fmx.harness_blob,
      fmx_harness_sha256: fmx.harness_sha256,
      fx_supplier_commit: FX_SUPPLIER_COMMIT,
      fx_supplier_tree: FX_SUPPLIER_TREE,
      fx_binary_path: FX_BINARY_PATH,
      fx_binary_sha256: FX_BINARY_SHA256,
      evidence_root: EVIDENCE_ROOT,
      provider_prepare_correlated: true,
      provider_build_correlated: true,
      inherited_permission_mode: "yolo",
      explicit_permission_mode: "auto",
      observed_line: "● Permissions: mode=auto",
      settings_sha256: SETTINGS_SHA256,
      settings_unchanged: true,
      process_exit_code: exitCode,
      process_reaped: true,
      provider_runtime_empty: true,
      provider_runtime_removed: true,
      files_before_manifest: inventory,
    })
  } catch (error) {
    if (child?.exitCode === null) child.kill("SIGKILL")
    await child?.exited.catch(() => {})
    terminal?.close()
    terminal = null
    await rmdir(providerRuntime).catch(() => {})
    const terminalBytes = terminalCapture.retainedBytes()
    await writePrivateIfAbsent(join(EVIDENCE_ROOT, "terminal.failure.raw"), terminalBytes)
    await writeJsonIfAbsent(join(EVIDENCE_ROOT, "failure.json"), {
      schema_id: "fmx.fx-launch-provider-real-process-failure",
      schema_version: 1,
      message: error instanceof Error ? error.message : String(error),
      terminal_bytes: terminalBytes.byteLength,
      terminal_sha256: sha256(terminalBytes),
      terminal_overflowed: terminalCapture.overflowed,
      retried: false,
    })
    throw error
  } finally {
    terminal?.close()
  }
}, 90_000)

async function verifyFmxSource() {
  const [commit, tree, consumerTree, ancestry, changedPaths, blob, hashed, status] = await Promise.all([
    git(["rev-parse", "HEAD^{commit}"], REPOSITORY_ROOT),
    git(["rev-parse", "HEAD^{tree}"], REPOSITORY_ROOT),
    git(["rev-parse", `${FMX_CONSUMER_COMMIT}^{tree}`], REPOSITORY_ROOT),
    git(["merge-base", "--is-ancestor", FMX_CONSUMER_COMMIT, "HEAD"], REPOSITORY_ROOT),
    git(["diff", "--name-only", `${FMX_CONSUMER_COMMIT}..HEAD`], REPOSITORY_ROOT),
    git(["rev-parse", `HEAD:${TEST_PATH}`], REPOSITORY_ROOT),
    git(["hash-object", "--no-filters", "--", TEST_PATH], REPOSITORY_ROOT),
    git(["status", "--porcelain=v1", "--untracked-files=all"], REPOSITORY_ROOT),
  ])
  expect(consumerTree.stdout.trim()).toBe(FMX_CONSUMER_TREE)
  expect(ancestry.exitCode).toBe(0)
  expect(changedPaths.stdout).toBe(`${TEST_PATH}\n`)
  expect(status.stdout).toBe("")
  expect(hashed.stdout.trim()).toBe(blob.stdout.trim())
  const harnessBytes = await readFile(join(REPOSITORY_ROOT, TEST_PATH))
  const tracked = await git(["show", `HEAD:${TEST_PATH}`], REPOSITORY_ROOT)
  expect(tracked.exitCode).toBe(0)
  expect(Buffer.from(tracked.stdout).equals(harnessBytes)).toBe(true)
  return {
    consumer_commit: FMX_CONSUMER_COMMIT,
    consumer_tree: consumerTree.stdout.trim(),
    harness_commit: commit.stdout.trim(),
    harness_tree: tree.stdout.trim(),
    harness_blob: blob.stdout.trim(),
    harness_sha256: sha256(harnessBytes),
    changed_paths_since_consumer: changedPaths.stdout.trim().split("\n"),
    worktree_status: status.stdout,
  }
}

async function verifySupplier(identityHome: string) {
  const [
    commit,
    tree,
    parents,
    status,
    permissionCarryParent,
    permissionUpstream,
    hostedCarryParent,
    hostedCarryPaths,
    hostedCarryNumstat,
  ] = await Promise.all([
    git(["rev-parse", "HEAD^{commit}"], FX_SUPPLIER_REPOSITORY),
    git(["rev-parse", "HEAD^{tree}"], FX_SUPPLIER_REPOSITORY),
    git(["show", "-s", "--format=%P", FX_SUPPLIER_COMMIT], FX_SUPPLIER_REPOSITORY),
    git(["status", "--porcelain=v1"], FX_SUPPLIER_REPOSITORY),
    git(["rev-parse", `${FX_SUPPLIER_PARENTS[1]}^`], FX_SUPPLIER_REPOSITORY),
    git(["merge-base", "--is-ancestor", FX_UPSTREAM_BASE, FX_PERMISSION_CARRY_PARENT], FX_SUPPLIER_REPOSITORY),
    git(["rev-parse", `${FX_HOSTED_CARRY}^`], FX_SUPPLIER_REPOSITORY),
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", FX_HOSTED_CARRY], FX_SUPPLIER_REPOSITORY),
    git(["diff", "--numstat", `${FX_HOSTED_CARRY}^`, FX_HOSTED_CARRY, "--", FX_HOSTED_CARRY_PATH], FX_SUPPLIER_REPOSITORY),
  ])
  expect(commit.stdout.trim()).toBe(FX_SUPPLIER_COMMIT)
  expect(tree.stdout.trim()).toBe(FX_SUPPLIER_TREE)
  expect(parents.stdout.trim().split(" ")).toEqual([...FX_SUPPLIER_PARENTS])
  expect(status.stdout).toBe("")
  expect(permissionCarryParent.stdout.trim()).toBe(FX_PERMISSION_CARRY_PARENT)
  expect(permissionUpstream.exitCode).toBe(0)
  expect(hostedCarryParent.stdout.trim()).toBe(FX_UPSTREAM_BASE)
  expect(hostedCarryPaths.stdout).toBe(`${FX_HOSTED_CARRY_PATH}\n`)
  expect(hostedCarryNumstat.stdout).toBe(`6\t3\t${FX_HOSTED_CARRY_PATH}\n`)

  const artifact = await artifactIdentity(FX_BINARY_PATH)
  expect(artifact).toEqual({
    path: FX_BINARY_PATH,
    realpath: FX_BINARY_PATH,
    sha256: FX_BINARY_SHA256,
    size: FX_BINARY_SIZE,
    mode: "0755",
    description: FX_FILE_DESCRIPTION,
  })
  const identityEnvironment = isolatedEnvironment(identityHome)
  delete identityEnvironment.FX_MODEL
  delete identityEnvironment.FX_EFFORT
  delete identityEnvironment.FX_PERMISSION_MODE
  const version = await run([FX_BINARY_PATH, "--version"], REPOSITORY_ROOT, identityEnvironment)
  expect(version).toEqual({ exitCode: 0, stdout: `${FX_VERSION}\n`, stderr: "" })
  const statusResult = await run([FX_BINARY_PATH, "status", "--json"], WORKSPACE, identityEnvironment)
  expect(statusResult.exitCode).toBe(0)
  expect(statusResult.stderr).toBe("")
  const statusJson = JSON.parse(statusResult.stdout) as Record<string, unknown>
  expect(statusJson.build_revision).toBe(FX_BUILD_REVISION)
  await writePrivate(join(EVIDENCE_ROOT, "fx-status.json"), statusResult.stdout)
  return {
    commit: commit.stdout.trim(),
    tree: tree.stdout.trim(),
    parents: parents.stdout.trim().split(" "),
    permission_carry_parent: permissionCarryParent.stdout.trim(),
    upstream_base: FX_UPSTREAM_BASE,
    upstream_is_ancestor: permissionUpstream.exitCode === 0,
    hosted_carry: FX_HOSTED_CARRY,
    hosted_carry_parent: hostedCarryParent.stdout.trim(),
    hosted_carry_changed_paths: hostedCarryPaths.stdout.trim().split("\n"),
    hosted_carry_numstat: hostedCarryNumstat.stdout.trim(),
    repository_status: status.stdout,
    artifact,
    version: version.stdout.trim(),
    build_revision: statusJson.build_revision,
  }
}

async function artifactIdentity(path: string) {
  expect(await realpath(path)).toBe(path)
  const facts = await lstat(path)
  expect(facts.isFile()).toBe(true)
  expect(facts.isSymbolicLink()).toBe(false)
  await access(path, constants.X_OK)
  const description = await run(["/usr/bin/file", "-b", path], REPOSITORY_ROOT)
  expect(description.exitCode).toBe(0)
  expect(description.stderr).toBe("")
  return {
    path,
    realpath: await realpath(path),
    sha256: sha256(await readFile(path)),
    size: facts.size,
    mode: (facts.mode & 0o777).toString(8).padStart(4, "0"),
    description: description.stdout.trim(),
  }
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FX_PERMISSION_MODE: "yolo",
    FX_MODEL: "openai/gpt-5",
    FX_EFFORT: "high",
    FX_AUTO_UPGRADE: "0",
    FX_DISABLE_KEYCHAIN: "1",
    FX_SKIP_ONBOARDING: "1",
  }
}

function readOnlyCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/var/empty",
    TMPDIR: "/tmp",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function assertFreshPrivateRoot(path: string): Promise<void> {
  expect(await realpath(path)).toBe(path)
  await assertPrivateDirectory(path)
  expect(await readdir(path)).toEqual([])
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const facts = await lstat(path)
  expect(facts.isDirectory()).toBe(true)
  expect(facts.isSymbolicLink()).toBe(false)
  expect(facts.uid).toBe(process.getuid!())
  expect(facts.mode & 0o777).toBe(0o700)
}

async function assertPathAbsent(path: string): Promise<void> {
  expect(await pathExists(path)).toBe(false)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function requireExactEnvironment(name: string, expected: string): void {
  if (process.env[name] !== expected) {
    throw new Error(`${name} must equal the frozen Phase 2 proof path ${expected}`)
  }
}

async function git(args: string[], cwd: string) {
  return run(["/usr/bin/git", ...args], cwd)
}

async function run(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = readOnlyCommandEnvironment(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env: stringEnvironment(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(25)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class BoundedTerminalCapture {
  private readonly chunks: Buffer[] = []
  private retainedByteLength = 0
  private receivedByteLength = 0
  overflowed = false

  constructor(private readonly maximumBytes: number) {
    if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("terminal capture bound must be a positive integer")
    }
  }

  append(bytes: Uint8Array): void {
    const chunk = Buffer.from(bytes)
    this.receivedByteLength += chunk.byteLength
    if (this.overflowed) return
    if (this.retainedByteLength + chunk.byteLength > this.maximumBytes) {
      this.overflowed = true
      return
    }
    this.chunks.push(chunk)
    this.retainedByteLength += chunk.byteLength
  }

  markBoundary(): number {
    this.assertWithinBound()
    return this.retainedByteLength
  }

  screen(cols: number, rows: number, boundary = 0): VtVisibleScreen {
    this.assertWithinBound()
    return VtVisibleScreen.fromBytes(this.retainedBytes(), boundary, cols, rows)
  }

  bytes(): Buffer {
    this.assertWithinBound()
    return this.retainedBytes()
  }

  retainedBytes(): Buffer {
    return Buffer.concat(this.chunks, this.retainedByteLength)
  }

  assertWithinBound(): void {
    if (this.overflowed) {
      throw new Error(
        `terminal capture exceeded ${this.maximumBytes} bytes after receiving ${this.receivedByteLength}`,
      )
    }
  }
}

type VtCell = {
  value: string
  afterBoundary: boolean
  concealed: boolean
  continuation: boolean
}

type VtBuffer = {
  cells: Array<Array<VtCell | null>>
  row: number
  col: number
  savedRow: number
  savedCol: number
  scrollTop: number
  scrollBottom: number
  wrapPending: boolean
  autoWrap: boolean
}

type VtState = {
  primary: VtBuffer
  alternate: VtBuffer
  active: "primary" | "alternate"
  concealed: boolean
}

class VtVisibleScreen {
  private primary: VtBuffer
  private alternate: VtBuffer
  private active: "primary" | "alternate" = "primary"
  private concealed = false
  private synchronizedBackup: VtState | null = null

  private constructor(
    private readonly cols: number,
    private readonly rows: number,
  ) {
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error("VT screen dimensions must be positive integers")
    }
    this.primary = createVtBuffer(cols, rows)
    this.alternate = createVtBuffer(cols, rows)
  }

  static fromBytes(bytes: Uint8Array, boundary: number, cols: number, rows: number): VtVisibleScreen {
    if (!Number.isInteger(boundary) || boundary < 0 || boundary > bytes.byteLength) {
      throw new Error("terminal observation boundary is outside the retained bytes")
    }
    const screen = new VtVisibleScreen(cols, rows)
    // A live PTY callback may end between UTF-8 code units. Replacement at
    // that transient boundary cannot synthesize the exact marker; the next
    // snapshot decodes the complete bounded byte stream again.
    const decoder = new TextDecoder("utf-8")
    screen.feed(decoder.decode(bytes.subarray(0, boundary), { stream: true }), false)
    screen.feed(decoder.decode(bytes.subarray(boundary), { stream: true }), true)
    screen.feed(decoder.decode(), true)
    screen.finishSynchronizedOutput()
    return screen
  }

  text(): string {
    const lines = this.buffer.cells.map((row) => row.map(visibleCell).join("").trimEnd())
    while (lines.at(-1) === "") lines.pop()
    return lines.join("\n")
  }

  hasVisibleLineAfter(marker: string): boolean {
    const wanted = Array.from(marker)
    if (wanted.length === 0 || wanted.some((character) => Bun.stringWidth(character) !== 1)) {
      throw new Error("visible marker must contain only single-cell characters")
    }
    return this.buffer.cells.some((row) => {
      for (let start = 0; start + wanted.length <= row.length; start++) {
        if (wanted.every((character, offset) => {
          const cell = row[start + offset]
          return cell !== null && !cell.continuation && !cell.concealed &&
            cell.afterBoundary && cell.value === character
        })) return true
      }
      return false
    })
  }

  private get buffer(): VtBuffer {
    return this.active === "primary" ? this.primary : this.alternate
  }

  private feed(input: string, afterBoundary: boolean): void {
    for (let index = 0; index < input.length;) {
      const code = input.codePointAt(index)!
      const character = String.fromCodePoint(code)
      if (character === "\u001b") {
        index = this.escape(input, index, afterBoundary)
        continue
      }
      index += character.length
      if (character === "\r") {
        this.buffer.col = 0
        this.buffer.wrapPending = false
      } else if (character === "\n" || character === "\u000b" || character === "\u000c") {
        this.lineFeed()
      } else if (character === "\b") {
        this.buffer.col = Math.max(0, this.buffer.col - 1)
        this.buffer.wrapPending = false
      } else if (character === "\t") {
        this.buffer.col = Math.min(this.cols - 1, (Math.floor(this.buffer.col / 8) + 1) * 8)
        this.buffer.wrapPending = false
      } else if (code >= 0x20 && code !== 0x7f) {
        this.put(character, afterBoundary)
      }
    }
  }

  private escape(input: string, start: number, afterBoundary: boolean): number {
    const next = input[start + 1]
    if (next === undefined) return input.length
    if (next === "[") {
      for (let end = start + 2; end < input.length; end++) {
        const code = input.charCodeAt(end)
        if (code >= 0x40 && code <= 0x7e) {
          this.csi(input.slice(start + 2, end), input[end]!, afterBoundary)
          return end + 1
        }
      }
      return input.length
    }
    if (["]", "P", "^", "_", "X"].includes(next)) {
      for (let end = start + 2; end < input.length; end++) {
        if (input[end] === "\u0007") return end + 1
        if (input[end] === "\u001b" && input[end + 1] === "\\") return end + 2
      }
      return input.length
    }
    if (["(", ")", "*", "+", "-", ".", "/"].includes(next)) return Math.min(input.length, start + 3)
    if (next === "7") this.saveCursor()
    else if (next === "8") this.restoreCursor()
    else if (next === "D") this.lineFeed()
    else if (next === "E") {
      this.buffer.col = 0
      this.lineFeed()
    } else if (next === "M") this.reverseIndex()
    else if (next === "c") this.reset()
    return start + 2
  }

  private csi(raw: string, final: string, afterBoundary: boolean): void {
    const privateMarker = /^[?<=>!]/u.test(raw) ? raw[0]! : ""
    const values = (privateMarker === "" ? raw : raw.slice(1)).split(";").map((value) => {
      const parsed = Number.parseInt(value.split(":", 1)[0] ?? "", 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
    const value = (index: number, fallback: number): number => {
      const candidate = values[index] ?? 0
      return candidate === 0 ? fallback : candidate
    }

    if ((final === "h" || final === "l") && privateMarker === "?") {
      for (const mode of values) this.privateMode(mode, final === "h")
      return
    }
    if (final === "m") {
      const attributes = raw === "" ? [0] : values
      for (const attribute of attributes) {
        if (attribute === 0 || attribute === 28) this.concealed = false
        else if (attribute === 8) this.concealed = true
      }
      return
    }

    const buffer = this.buffer
    switch (final) {
      case "A": this.moveCursor(-value(0, 1), 0); break
      case "B": case "e": this.moveCursor(value(0, 1), 0); break
      case "C": case "a": this.moveCursor(0, value(0, 1)); break
      case "D": this.moveCursor(0, -value(0, 1)); break
      case "E": this.moveCursor(value(0, 1), -buffer.col); break
      case "F": this.moveCursor(-value(0, 1), -buffer.col); break
      case "G": case "`": this.setCursor(buffer.row, value(0, 1) - 1); break
      case "d": this.setCursor(value(0, 1) - 1, buffer.col); break
      case "H": case "f": this.setCursor(value(0, 1) - 1, value(1, 1) - 1); break
      case "J": this.eraseDisplay(values[0] ?? 0, afterBoundary); break
      case "K": this.eraseLine(values[0] ?? 0, afterBoundary); break
      case "S": this.scrollUp(value(0, 1)); break
      case "T": this.scrollDown(value(0, 1)); break
      case "@": this.insertCells(value(0, 1)); break
      case "P": this.deleteCells(value(0, 1)); break
      case "X": this.eraseCells(value(0, 1), afterBoundary); break
      case "L": this.insertLines(value(0, 1)); break
      case "M": this.deleteLines(value(0, 1)); break
      case "s": this.saveCursor(); break
      case "u": this.restoreCursor(); break
      case "r": {
        const top = value(0, 1) - 1
        const bottom = value(1, this.rows) - 1
        if (top >= 0 && bottom < this.rows && top < bottom) {
          buffer.scrollTop = top
          buffer.scrollBottom = bottom
          this.setCursor(0, 0)
        }
        break
      }
    }
  }

  private privateMode(mode: number, enabled: boolean): void {
    if (mode === 2026) {
      if (enabled && this.synchronizedBackup === null) this.synchronizedBackup = this.state()
      else if (!enabled) this.synchronizedBackup = null
      return
    }
    if (mode === 7) {
      this.buffer.autoWrap = enabled
      return
    }
    if (![47, 1047, 1049].includes(mode)) return
    if (enabled) {
      if (mode === 1049) this.saveCursor()
      this.alternate = createVtBuffer(this.cols, this.rows)
      this.active = "alternate"
    } else {
      this.active = "primary"
      if (mode === 1049) this.restoreCursor()
    }
  }

  private put(character: string, afterBoundary: boolean): void {
    const buffer = this.buffer
    const width = Bun.stringWidth(character)
    if (width === 0) {
      const previous = buffer.cells[buffer.row]?.[Math.max(0, buffer.col - 1)]
      if (previous && !previous.continuation) previous.value += character
      return
    }
    if (buffer.wrapPending) {
      if (buffer.autoWrap) {
        buffer.col = 0
        this.lineFeed()
      }
      buffer.wrapPending = false
    }
    const resolvedWidth = Math.min(width, 2)
    if (resolvedWidth === 2 && buffer.col === this.cols - 1) {
      if (buffer.autoWrap) {
        buffer.col = 0
        this.lineFeed()
      } else return
    }
    this.clearCellOverlap(buffer.row, buffer.col)
    buffer.cells[buffer.row]![buffer.col] = {
      value: character,
      afterBoundary,
      concealed: this.concealed,
      continuation: false,
    }
    if (resolvedWidth === 2) {
      buffer.cells[buffer.row]![buffer.col + 1] = {
        value: "",
        afterBoundary,
        concealed: this.concealed,
        continuation: true,
      }
    }
    if (buffer.col + resolvedWidth >= this.cols) {
      buffer.col = this.cols - 1
      buffer.wrapPending = true
    } else buffer.col += resolvedWidth
  }

  private clearCellOverlap(row: number, col: number): void {
    const cells = this.buffer.cells[row]!
    if (cells[col]?.continuation && col > 0) cells[col - 1] = null
    if (cells[col] && !cells[col]?.continuation && cells[col + 1]?.continuation) cells[col + 1] = null
  }

  private lineFeed(): void {
    const buffer = this.buffer
    buffer.wrapPending = false
    if (buffer.row === buffer.scrollBottom) this.scrollUp(1)
    else buffer.row = Math.min(this.rows - 1, buffer.row + 1)
  }

  private reverseIndex(): void {
    const buffer = this.buffer
    buffer.wrapPending = false
    if (buffer.row === buffer.scrollTop) this.scrollDown(1)
    else buffer.row = Math.max(0, buffer.row - 1)
  }

  private moveCursor(rows: number, cols: number): void {
    this.setCursor(this.buffer.row + rows, this.buffer.col + cols)
  }

  private setCursor(row: number, col: number): void {
    const buffer = this.buffer
    buffer.row = clamp(row, 0, this.rows - 1)
    buffer.col = clamp(col, 0, this.cols - 1)
    buffer.wrapPending = false
  }

  private saveCursor(): void {
    const buffer = this.buffer
    buffer.savedRow = buffer.row
    buffer.savedCol = buffer.col
  }

  private restoreCursor(): void {
    this.setCursor(this.buffer.savedRow, this.buffer.savedCol)
  }

  private eraseDisplay(mode: number, afterBoundary: boolean): void {
    const buffer = this.buffer
    if (mode === 2 || mode === 3) {
      buffer.cells = createCells(this.cols, this.rows)
      return
    }
    if (mode === 0) {
      this.eraseCells(this.cols - buffer.col, afterBoundary)
      for (let row = buffer.row + 1; row < this.rows; row++) buffer.cells[row] = blankRow(this.cols)
    } else if (mode === 1) {
      for (let row = 0; row < buffer.row; row++) buffer.cells[row] = blankRow(this.cols)
      for (let col = 0; col <= buffer.col; col++) buffer.cells[buffer.row]![col] = null
    }
  }

  private eraseLine(mode: number, _afterBoundary: boolean): void {
    const buffer = this.buffer
    const start = mode === 0 ? buffer.col : 0
    const end = mode === 1 ? buffer.col : this.cols - 1
    for (let col = start; col <= end; col++) buffer.cells[buffer.row]![col] = null
  }

  private eraseCells(count: number, _afterBoundary: boolean): void {
    const buffer = this.buffer
    const end = Math.min(this.cols, buffer.col + count)
    for (let col = buffer.col; col < end; col++) buffer.cells[buffer.row]![col] = null
  }

  private insertCells(count: number): void {
    const buffer = this.buffer
    const row = buffer.cells[buffer.row]!
    row.splice(buffer.col, 0, ...blankRow(Math.min(count, this.cols - buffer.col)))
    row.length = this.cols
  }

  private deleteCells(count: number): void {
    const buffer = this.buffer
    const row = buffer.cells[buffer.row]!
    row.splice(buffer.col, Math.min(count, this.cols - buffer.col))
    while (row.length < this.cols) row.push(null)
  }

  private insertLines(count: number): void {
    const buffer = this.buffer
    if (buffer.row < buffer.scrollTop || buffer.row > buffer.scrollBottom) return
    const amount = Math.min(count, buffer.scrollBottom - buffer.row + 1)
    buffer.cells.splice(buffer.row, 0, ...Array.from({ length: amount }, () => blankRow(this.cols)))
    buffer.cells.splice(buffer.scrollBottom + 1, amount)
  }

  private deleteLines(count: number): void {
    const buffer = this.buffer
    if (buffer.row < buffer.scrollTop || buffer.row > buffer.scrollBottom) return
    const amount = Math.min(count, buffer.scrollBottom - buffer.row + 1)
    buffer.cells.splice(buffer.row, amount)
    buffer.cells.splice(
      buffer.scrollBottom - amount + 1,
      0,
      ...Array.from({ length: amount }, () => blankRow(this.cols)),
    )
  }

  private scrollUp(count: number): void {
    const buffer = this.buffer
    const amount = Math.min(count, buffer.scrollBottom - buffer.scrollTop + 1)
    buffer.cells.splice(buffer.scrollTop, amount)
    buffer.cells.splice(
      buffer.scrollBottom - amount + 1,
      0,
      ...Array.from({ length: amount }, () => blankRow(this.cols)),
    )
  }

  private scrollDown(count: number): void {
    const buffer = this.buffer
    const amount = Math.min(count, buffer.scrollBottom - buffer.scrollTop + 1)
    buffer.cells.splice(
      buffer.scrollTop,
      0,
      ...Array.from({ length: amount }, () => blankRow(this.cols)),
    )
    buffer.cells.splice(buffer.scrollBottom + 1, amount)
  }

  private state(): VtState {
    return {
      primary: cloneVtBuffer(this.primary),
      alternate: cloneVtBuffer(this.alternate),
      active: this.active,
      concealed: this.concealed,
    }
  }

  private finishSynchronizedOutput(): void {
    if (this.synchronizedBackup === null) return
    this.primary = this.synchronizedBackup.primary
    this.alternate = this.synchronizedBackup.alternate
    this.active = this.synchronizedBackup.active
    this.concealed = this.synchronizedBackup.concealed
    this.synchronizedBackup = null
  }

  private reset(): void {
    this.primary = createVtBuffer(this.cols, this.rows)
    this.alternate = createVtBuffer(this.cols, this.rows)
    this.active = "primary"
    this.concealed = false
    this.synchronizedBackup = null
  }
}

function createVtBuffer(cols: number, rows: number): VtBuffer {
  return {
    cells: createCells(cols, rows),
    row: 0,
    col: 0,
    savedRow: 0,
    savedCol: 0,
    scrollTop: 0,
    scrollBottom: rows - 1,
    wrapPending: false,
    autoWrap: true,
  }
}

function cloneVtBuffer(buffer: VtBuffer): VtBuffer {
  return {
    ...buffer,
    cells: buffer.cells.map((row) => row.map((cell) => cell === null ? null : { ...cell })),
  }
}

function createCells(cols: number, rows: number): Array<Array<VtCell | null>> {
  return Array.from({ length: rows }, () => blankRow(cols))
}

function blankRow(cols: number): Array<VtCell | null> {
  return Array.from({ length: cols }, () => null)
}

function visibleCell(cell: VtCell | null): string {
  return cell === null || cell.concealed || cell.continuation ? " " : cell.value
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

async function waitForStablePermissionScreen(
  capture: BoundedTerminalCapture,
  boundary: number,
  marker: string,
): Promise<VtVisibleScreen> {
  const deadline = Date.now() + WAIT_MS
  let lastText: string | null = null
  let stableSince = 0
  for (;;) {
    capture.assertWithinBound()
    const screen = capture.screen(120, 40, boundary)
    const text = screen.text()
    if (screen.hasVisibleLineAfter(marker)) {
      if (text !== lastText) {
        lastText = text
        stableSince = Date.now()
      } else if (Date.now() - stableSince >= 100) return screen
    } else {
      lastText = null
      stableSince = 0
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for stable visible ${marker}`)
    await Bun.sleep(25)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function evidenceInventory(root: string) {
  const names = (await readdir(root)).sort()
  const files: Array<{ path: string; bytes: number; mode: string; sha256: string }> = []
  for (const name of names) {
    const path = join(root, name)
    const facts = await lstat(path)
    if (!facts.isFile()) continue
    files.push({
      path: name,
      bytes: facts.size,
      mode: (facts.mode & 0o777).toString(8).padStart(4, "0"),
      sha256: sha256(await readFile(path)),
    })
  }
  return files
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeJsonIfAbsent(path: string, value: unknown): Promise<void> {
  await writePrivateIfAbsent(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600, flag: "wx" })
  expect((await lstat(path)).mode & 0o777).toBe(0o600)
}

async function writePrivateIfAbsent(path: string, value: string | Uint8Array): Promise<void> {
  try {
    await writePrivate(path, value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
