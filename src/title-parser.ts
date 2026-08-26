const ESC = 0x1b
const BEL = 0x07
const OSC_LIMIT = 1024

type OscTitleParserOptions = {
  onTitle: (title: string) => void
}

type ParserState = "ground" | "escape" | "osc" | "osc-escape"

/**
 * Observes OSC 0/2 titles without modifying the PTY byte stream.
 * Input may be split at any byte boundary.
 */
export class OscTitleParser {
  private state: ParserState = "ground"
  private payload: number[] = []
  private readonly decoder = new TextDecoder("utf-8", { fatal: false })

  constructor(private readonly options: OscTitleParserOptions) {}

  push(bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.byteLength) {
      // Outside a sequence nothing but an escape can matter, and this sees
      // every byte fx writes: jump to the next one rather than walking there.
      if (this.state === "ground") {
        const escape = bytes.indexOf(ESC, offset)
        if (escape === -1) return
        offset = escape
      }
      this.pushByte(bytes[offset]!)
      offset += 1
    }
  }

  private reset(): void {
    this.state = "ground"
    this.payload = []
  }

  private pushByte(byte: number): void {
    switch (this.state) {
      case "ground":
        if (byte === ESC) this.state = "escape"
        return

      case "escape":
        if (byte === 0x5d) {
          this.payload = []
          this.state = "osc"
        } else {
          this.state = byte === ESC ? "escape" : "ground"
        }
        return

      case "osc":
        if (byte === BEL) {
          this.finishOsc()
        } else if (byte === ESC) {
          this.state = "osc-escape"
        } else {
          this.appendPayload(byte)
        }
        return

      case "osc-escape":
        if (byte === 0x5c) {
          this.finishOsc()
          return
        }
        if (!this.appendPayload(ESC)) return
        if (!this.appendPayload(byte)) return
        this.state = "osc"
    }
  }

  private appendPayload(byte: number): boolean {
    if (this.payload.length >= OSC_LIMIT) {
      this.reset()
      return false
    }
    this.payload.push(byte)
    return true
  }

  private finishOsc(): void {
    const payload = this.decoder.decode(Uint8Array.from(this.payload))
    const separator = payload.indexOf(";")
    if (separator > 0) {
      const command = payload.slice(0, separator)
      if (command === "0" || command === "2") {
        this.options.onTitle(sanitizeFxTitle(payload.slice(separator + 1)))
      }
    }
    this.reset()
  }
}

export function sanitizeTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .slice(0, 160)
}

export function sanitizeFxTitle(value: string): string {
  return sanitizeTitle(value).replace(/^fx · /u, "")
}
