const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"])

export const CONTRACT_FRAME_HEADER_BYTES = 4
export const CONTRACT_MAX_FRAME_BYTES = 1024 * 1024
export const CONTRACT_MAX_JSON_DEPTH = 64

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ContractCodecErrorCode =
  | "duplicate_key"
  | "empty_frame"
  | "frame_too_large"
  | "invalid_message"
  | "invalid_utf8"
  | "malformed_frame"
  | "malformed_json"
  | "unsupported_schema"
  | "unsupported_schema_version"

export class ContractCodecError extends Error {
  constructor(
    readonly code: ContractCodecErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ContractCodecError"
  }
}

/**
 * Canonical JSON for Phase 0 contract bytes: object keys are UTF-16 sorted,
 * arrays retain order, and no insignificant whitespace or trailing newline is
 * emitted. Fixture files add one newline after every encoded envelope.
 */
export function encodeCanonicalJson(value: JsonValue): Uint8Array {
  const text = canonicalJson(value, 0)
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength === 0 || encoded.byteLength > CONTRACT_MAX_FRAME_BYTES) {
    throw new ContractCodecError(
      "frame_too_large",
      `canonical payload is ${encoded.byteLength} bytes; expected 1-${CONTRACT_MAX_FRAME_BYTES}`,
    )
  }
  return encoded
}

export function decodeStrictJson(bytes: Uint8Array): JsonValue {
  if (bytes.byteLength === 0) {
    throw new ContractCodecError("empty_frame", "contract payload is empty")
  }
  if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
    throw new ContractCodecError(
      "frame_too_large",
      `contract payload is ${bytes.byteLength} bytes; maximum is ${CONTRACT_MAX_FRAME_BYTES}`,
    )
  }

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new ContractCodecError("invalid_utf8", "contract payload is not valid UTF-8")
  }
  return new StrictJsonParser(text).parse()
}

/** Four-byte big-endian length followed by one canonical JSON payload. */
export function encodeContractFrame(payload: Uint8Array): Uint8Array {
  validatePayloadLength(payload.byteLength)
  const frame = new Uint8Array(CONTRACT_FRAME_HEADER_BYTES + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
  frame.set(payload, CONTRACT_FRAME_HEADER_BYTES)
  return frame
}

/** Decode exactly one frame. Trailing bytes are a second/ambiguous frame. */
export function decodeContractFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < CONTRACT_FRAME_HEADER_BYTES) {
    throw new ContractCodecError("malformed_frame", "contract frame is shorter than its 4-byte header")
  }
  const announced = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
  validatePayloadLength(announced)
  const expected = CONTRACT_FRAME_HEADER_BYTES + announced
  if (frame.byteLength !== expected) {
    throw new ContractCodecError(
      "malformed_frame",
      `contract frame has ${frame.byteLength} bytes; header requires exactly ${expected}`,
    )
  }
  return frame.slice(CONTRACT_FRAME_HEADER_BYTES)
}

/**
 * Streaming frame decoder for the later extension host. Complete frames are
 * returned immediately; only one bounded partial frame is retained.
 */
export class ContractFrameDecoder {
  private pending = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return []
    const input = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    input.set(this.pending)
    input.set(chunk, this.pending.byteLength)
    this.pending = new Uint8Array(0)

    const frames: Uint8Array[] = []
    let offset = 0
    while (input.byteLength - offset >= CONTRACT_FRAME_HEADER_BYTES) {
      const announced = new DataView(
        input.buffer,
        input.byteOffset + offset,
        input.byteLength - offset,
      ).getUint32(0, false)
      validatePayloadLength(announced)
      const frameBytes = CONTRACT_FRAME_HEADER_BYTES + announced
      if (input.byteLength - offset < frameBytes) break
      frames.push(input.slice(offset + CONTRACT_FRAME_HEADER_BYTES, offset + frameBytes))
      offset += frameBytes
    }

    if (offset < input.byteLength) {
      const remainder = input.slice(offset)
      if (remainder.byteLength > CONTRACT_FRAME_HEADER_BYTES + CONTRACT_MAX_FRAME_BYTES) {
        throw new ContractCodecError("frame_too_large", "partial contract frame exceeds the frame bound")
      }
      this.pending = remainder
    }
    return frames
  }

  /** Refuse EOF while any header or announced payload remains incomplete. */
  finish(): void {
    if (this.pending.byteLength === 0) return
    if (this.pending.byteLength < CONTRACT_FRAME_HEADER_BYTES) {
      throw new ContractCodecError(
        "malformed_frame",
        `contract stream ended with a ${this.pending.byteLength}-byte partial header`,
      )
    }
    const announced = new DataView(
      this.pending.buffer,
      this.pending.byteOffset,
      this.pending.byteLength,
    ).getUint32(0, false)
    validatePayloadLength(announced)
    throw new ContractCodecError(
      "malformed_frame",
      `contract stream ended with ${this.pending.byteLength - CONTRACT_FRAME_HEADER_BYTES} of ${announced} payload bytes`,
    )
  }

  get pendingBytes(): number {
    return this.pending.byteLength
  }
}

function validatePayloadLength(length: number): void {
  if (length === 0) throw new ContractCodecError("empty_frame", "contract frame announced an empty payload")
  if (length > CONTRACT_MAX_FRAME_BYTES) {
    throw new ContractCodecError(
      "frame_too_large",
      `contract frame announced ${length} bytes; maximum is ${CONTRACT_MAX_FRAME_BYTES}`,
    )
  }
}

function canonicalJson(value: JsonValue, depth: number): string {
  if (depth > CONTRACT_MAX_JSON_DEPTH) {
    throw new ContractCodecError("invalid_message", `contract JSON exceeds ${CONTRACT_MAX_JSON_DEPTH} levels`)
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "string") {
    assertUnicodeScalarString(value, "string value")
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractCodecError("invalid_message", "contract JSON numbers must be finite")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new ContractCodecError("invalid_message", "contract JSON arrays must not be sparse")
      }
    }
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`
  }
  if (typeof value !== "object") {
    throw new ContractCodecError("invalid_message", `unsupported contract JSON value: ${String(value)}`)
  }

  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => {
    assertUnicodeScalarString(key, "object key")
    const child = value[key]
    if (child === undefined) {
      throw new ContractCodecError("invalid_message", `contract JSON field ${JSON.stringify(key)} is undefined`)
    }
    return `${JSON.stringify(key)}:${canonicalJson(child, depth + 1)}`
  }).join(",")}}`
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0xd800 || code > 0xdfff) continue
    if (code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++
        continue
      }
    }
    throw new ContractCodecError("invalid_message", `${label} contains an unpaired UTF-16 surrogate`)
  }
}

class StrictJsonParser {
  private offset = 0

  constructor(private readonly text: string) {}

  parse(): JsonValue {
    this.skipWhitespace()
    const value = this.parseValue(0)
    this.skipWhitespace()
    if (this.offset !== this.text.length) this.fail("trailing bytes after the JSON value")
    return value
  }

  private parseValue(depth: number): JsonValue {
    if (depth > CONTRACT_MAX_JSON_DEPTH) {
      throw new ContractCodecError("malformed_json", `contract JSON exceeds ${CONTRACT_MAX_JSON_DEPTH} levels`)
    }
    switch (this.text[this.offset]) {
      case "{":
        return this.parseObject(depth + 1)
      case "[":
        return this.parseArray(depth + 1)
      case '"':
        return this.parseString()
      case "t":
        this.expectKeyword("true")
        return true
      case "f":
        this.expectKeyword("false")
        return false
      case "n":
        this.expectKeyword("null")
        return null
      default:
        return this.parseNumber()
    }
  }

  private parseObject(depth: number): { [key: string]: JsonValue } {
    this.offset++
    this.skipWhitespace()
    const value: { [key: string]: JsonValue } = Object.create(null)
    const keys = new Set<string>()
    if (this.take("}")) return value
    while (true) {
      if (this.text[this.offset] !== '"') this.fail("object keys must be JSON strings")
      const key = this.parseString()
      if (keys.has(key)) {
        throw new ContractCodecError("duplicate_key", `duplicate JSON object key ${JSON.stringify(key)}`)
      }
      keys.add(key)
      this.skipWhitespace()
      if (!this.take(":")) this.fail("expected ':' after object key")
      this.skipWhitespace()
      value[key] = this.parseValue(depth)
      this.skipWhitespace()
      if (this.take("}")) return value
      if (!this.take(",")) this.fail("expected ',' or '}' in object")
      this.skipWhitespace()
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.offset++
    this.skipWhitespace()
    const value: JsonValue[] = []
    if (this.take("]")) return value
    while (true) {
      value.push(this.parseValue(depth))
      this.skipWhitespace()
      if (this.take("]")) return value
      if (!this.take(",")) this.fail("expected ',' or ']' in array")
      this.skipWhitespace()
    }
  }

  private parseString(): string {
    const start = this.offset
    this.offset++
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset)
      if (code === 0x22) {
        this.offset++
        let value: string
        try {
          value = JSON.parse(this.text.slice(start, this.offset)) as string
        } catch {
          this.fail("invalid JSON string escape")
        }
        assertUnicodeScalarString(value!, "JSON string")
        return value!
      }
      if (code < 0x20) this.fail("raw control character in JSON string")
      if (code === 0x5c) {
        this.offset++
        const escaped = this.text[this.offset]
        if (escaped === "u") {
          const hex = this.text.slice(this.offset + 1, this.offset + 5)
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.fail("invalid Unicode escape in JSON string")
          this.offset += 5
          continue
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) {
          this.fail("invalid escape in JSON string")
        }
      }
      this.offset++
    }
    this.fail("unterminated JSON string")
  }

  private parseNumber(): number {
    const rest = this.text.slice(this.offset)
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest)
    if (!match) this.fail("expected a JSON value")
    this.offset += match![0].length
    const value = Number(match![0])
    if (!Number.isFinite(value)) this.fail("JSON number is outside the finite range")
    return value
  }

  private expectKeyword(keyword: "true" | "false" | "null"): void {
    if (!this.text.startsWith(keyword, this.offset)) this.fail(`expected ${keyword}`)
    this.offset += keyword.length
  }

  private skipWhitespace(): void {
    while (this.offset < this.text.length && JSON_WHITESPACE.has(this.text[this.offset]!)) this.offset++
  }

  private take(character: string): boolean {
    if (this.text[this.offset] !== character) return false
    this.offset++
    return true
  }

  private fail(message: string): never {
    throw new ContractCodecError("malformed_json", `${message} at character ${this.offset}`)
  }
}
