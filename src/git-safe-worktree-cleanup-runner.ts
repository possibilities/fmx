import {
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import { executePreparedRemovalOperation } from "./git-safe-worktree-cleanup.ts"

async function readInput(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of Bun.stdin.stream()) {
    total += chunk.byteLength
    if (total > CONTRACT_MAX_FRAME_BYTES) {
      throw new Error("prepared Git removal input exceeds its private bound")
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

try {
  const input = decodeStrictJson(await readInput())
  const result = await executePreparedRemovalOperation(input)
  process.stdout.write(encodeCanonicalJson(result as unknown as JsonValue))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
