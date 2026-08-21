import { expect, test } from "bun:test"
import { decodeFrame, formatPayload } from "../src/socket-frames.ts"

const REPORT =
  '{"id":"1","method":"pane.report_agent","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","state":"working"}}'

function frame(line: string) {
  return decodeFrame(0, 0, line)
}

test("re-indents a payload two spaces per level for reading", () => {
  expect(formatPayload(frame(REPORT))).toBe(`{
  "id": "1",
  "method": "pane.report_agent",
  "params": {
    "pane_id": "p_1",
    "source": "custom:fx",
    "agent": "fx",
    "state": "working"
  }
}`)
})

test("leaves the wire line on the frame untouched", () => {
  const decoded = frame(REPORT)
  expect(decoded.payload).toBe(REPORT)
  expect(formatPayload(decoded)).not.toBe(decoded.payload)
})

test("shows a malformed payload exactly as it arrived", () => {
  const decoded = frame("not json at all")
  expect(decoded.malformed).toBe(true)
  expect(formatPayload(decoded)).toBe("not json at all")
})

test("shows an unparseable payload rather than nothing", () => {
  // A frame whose stored payload cannot round-trip — truncation past the
  // closing brace is the real case — still renders.
  const decoded = { ...frame(REPORT), payload: '{"id":"1","method":"pane.rep' }
  expect(formatPayload(decoded)).toBe('{"id":"1","method":"pane.rep')
})

test("keeps nesting readable in the reply fmx waits for", () => {
  expect(formatPayload(frame('{"id":"7","result":{}}'))).toBe(`{
  "id": "7",
  "result": {}
}`)
})
