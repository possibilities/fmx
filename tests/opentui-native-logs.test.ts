import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const PAGE_CAPACITY_FIXTURE = fileURLToPath(new URL("./fixtures/opentui-page-capacity.ts", import.meta.url))

test("native terminal bookkeeping never writes through the Runtime screen", async () => {
  const child = Bun.spawn([process.execPath, PAGE_CAPACITY_FIXTURE], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  expect(exitCode).toBe(0)
  expect(stdout).toBe("")
  expect(stderr).toBe("")
})
