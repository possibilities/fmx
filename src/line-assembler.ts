/** A peer that never sends a newline must not grow the buffer without bound. */
const MAX_PENDING_CHARS = 64 * 1024

/** Reassemble newline-delimited records from arbitrary chunk boundaries. */
export class LineAssembler {
  private pending = ""

  push(chunk: string): string[] {
    if (this.pending.length + chunk.length > MAX_PENDING_CHARS) {
      this.pending = ""
      return []
    }
    this.pending += chunk
    const lines: string[] = []
    let newline = this.pending.indexOf("\n")
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (line.trim().length > 0) lines.push(line)
      newline = this.pending.indexOf("\n")
    }
    return lines
  }

  /** Any bytes left when a peer closes without a trailing newline. */
  flush(): string[] {
    const remainder = this.pending.trim()
    this.pending = ""
    return remainder.length > 0 ? [remainder] : []
  }
}
