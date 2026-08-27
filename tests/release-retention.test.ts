import { expect, test } from "bun:test"

const workflow = await Bun.file(
  new URL("../.github/workflows/release.yml", import.meta.url),
).text()

test("release publication verifies the replacement before pruning history", () => {
  const publish = workflow.indexOf("name: Publish immutable artifacts and installer")
  const verify = workflow.indexOf("name: Verify public release")
  const prune = workflow.indexOf("name: Prune historical Fmx releases")
  const tag = workflow.indexOf("name: Tag released commit")

  expect(publish).toBeGreaterThan(-1)
  expect(verify).toBeGreaterThan(publish)
  expect(prune).toBeGreaterThan(verify)
  expect(tag).toBeGreaterThan(prune)
  expect(workflow).toContain('release_prefix="$(blob_path releases/)"')
  expect(workflow).toContain('keep_prefix="$(blob_path "releases/v$VERSION/")"')
  expect(workflow).toContain("https://blob.vercel-storage.com/delete")
  expect(workflow).toContain("Historical Fmx releases remain after pruning")
})
