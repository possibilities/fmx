# Names select independent smolmux Sessions with shared configuration

Its persisted state is superseded by
[ADR 0018](0018-labels-are-the-record.md); `--name` and the independence it
establishes remain in force.

`smolmux --name NAME` selects an smolmux Session whose internal state lives under
`~/.config/smolmux/homes/<name>`, giving it
independent Agents, Manifest, UI state, Runtime, Clients, and private sockets,
while every name reads the one root `config.toml` and shares Fx's profile,
repositories, and binaries. Plain `smolmux` and `--name default` keep the existing
default smolmux Session and all of its paths and identity unchanged; names add no catalog or
Runtime lifecycle commands.
