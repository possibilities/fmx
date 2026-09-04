/** Decode complete UTF-8 lines and bound retained bytes even with one-byte reads. */
export class LineBuffer {
  private buffer = Buffer.alloc(0)
  private bytes = 0
  constructor(private readonly limit: number) {}
  push(data: Buffer, accept: (line: string) => void): void {
    let start = 0
    while (start < data.length) {
      const newline = data.indexOf(10, start)
      const end = newline < 0 ? data.length : newline
      const part = data.subarray(start, end)
      const length = this.bytes + part.length
      if (length > this.limit) {
        const prefix = Buffer.concat(
          [this.buffer.subarray(0, Math.min(this.bytes, 512)), part.subarray(0, 512)],
          Math.min(512, length),
        ).toString("utf8")
        this.clear()
        throw new FrameLimitError(prefix)
      }
      if (this.buffer.length < length) {
        const next = Buffer.allocUnsafe(Math.min(this.limit, Math.max(length, 256, this.buffer.length * 2)))
        this.buffer.copy(next, 0, 0, this.bytes)
        this.buffer = next
      }
      part.copy(this.buffer, this.bytes)
      this.bytes = length
      if (newline < 0) return
      const line = this.buffer.toString("utf8", 0, this.bytes)
      this.bytes = 0
      accept(line)
      start = newline + 1
    }
  }
  clear(): void {
    this.buffer = Buffer.alloc(0)
    this.bytes = 0
  }
}
export class FrameLimitError extends Error {
  constructor(readonly prefix: string) {
    super("frame too large")
  }
}
