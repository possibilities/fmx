#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createFmxMcpServer } from "./mcp-server.ts"

async function main(): Promise<void> {
  await createFmxMcpServer().connect(new StdioServerTransport())
}

main().catch((error) => {
  process.stderr.write(`fmx-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
