# The stable Runtime socket is a single-request bridge

[ADR 0013](0013-mcp-only-agent-automation.md) supersedes this decision's public
clients and multiplexed event protocol. The stable mode-0600
`/tmp/fmx-<uid>/<home id>.bus` path remains so surviving Agents retain their
Runtime address, but it now carries exactly one private MCP request and one
response per connection; `.obs` and `.ctl` remain retired residue only.
