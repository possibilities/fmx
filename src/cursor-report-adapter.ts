const ESC = 0x1b
const LEFT_BRACKET = 0x5b
const QUESTION_MARK = 0x3f
const SIX = 0x36
const DSR_FINAL = 0x6e
const CPR_FINAL = 0x52

const PRIVATE_CURSOR_REPORT_REQUEST = Uint8Array.of(ESC, LEFT_BRACKET, QUESTION_MARK, SIX, DSR_FINAL)
const STANDARD_CURSOR_REPORT_REQUEST = Uint8Array.of(ESC, LEFT_BRACKET, SIX, DSR_FINAL)

/**
 * OpenTUI 0.5.6's embedded Ghostty terminal supports ANSI CPR queries (CSI 6 n)
 * but not DEC private CPR queries (CSI ? 6 n). fx uses the private form so its
 * resize probes cannot be confused with user input. Translate only that query
 * at the emulator boundary, then restore the private marker on the generated
 * response before it reaches fx.
 */
export class CursorReportAdapter {
  private requestPrefix: number[] = []
  private privateResponsesPending = 0

  toTerminal(bytes: Uint8Array): Uint8Array {
    const output: number[] = []
    for (const byte of bytes) this.consumeRequestByte(byte, output)
    return Uint8Array.from(output)
  }

  toPty(bytes: Uint8Array): Uint8Array {
    if (this.privateResponsesPending === 0 || bytes.byteLength === 0) return bytes

    const output: number[] = []
    let offset = 0
    let changed = false
    while (offset < bytes.byteLength) {
      const end = this.privateResponsesPending > 0 ? cursorPositionReportEnd(bytes, offset) : -1
      if (end === -1) {
        output.push(bytes[offset]!)
        offset += 1
        continue
      }

      output.push(ESC, LEFT_BRACKET, QUESTION_MARK)
      for (let index = offset + 2; index < end; index += 1) output.push(bytes[index]!)
      this.privateResponsesPending -= 1
      offset = end
      changed = true
    }
    return changed ? Uint8Array.from(output) : bytes
  }

  flushTerminalBytes(): Uint8Array {
    const bytes = Uint8Array.from(this.requestPrefix)
    this.requestPrefix = []
    return bytes
  }

  private consumeRequestByte(byte: number, output: number[]): void {
    if (this.requestPrefix.length === 0) {
      if (byte === ESC) this.requestPrefix.push(byte)
      else output.push(byte)
      return
    }

    if (byte === PRIVATE_CURSOR_REPORT_REQUEST[this.requestPrefix.length]) {
      this.requestPrefix.push(byte)
      if (this.requestPrefix.length === PRIVATE_CURSOR_REPORT_REQUEST.length) {
        output.push(...STANDARD_CURSOR_REPORT_REQUEST)
        this.requestPrefix = []
        this.privateResponsesPending += 1
      }
      return
    }

    output.push(...this.requestPrefix)
    this.requestPrefix = []
    if (byte === ESC) this.requestPrefix.push(byte)
    else output.push(byte)
  }
}

function cursorPositionReportEnd(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] !== ESC || bytes[offset + 1] !== LEFT_BRACKET) return -1

  let index = offset + 2
  const rowStart = index
  while (isAsciiDigit(bytes[index])) index += 1
  if (index === rowStart || bytes[index] !== 0x3b) return -1

  index += 1
  const columnStart = index
  while (isAsciiDigit(bytes[index])) index += 1
  if (index === columnStart || bytes[index] !== CPR_FINAL) return -1
  return index + 1
}

function isAsciiDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39
}
