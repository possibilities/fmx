# Names select independent fmx Sessions with shared configuration

`fmx --name NAME` selects an fmx Session whose internal state lives under
`~/.config/fmx/homes/<name>`, giving it
independent Agents, Manifest, UI state, Runtime, Clients, and private sockets,
while every name reads the one root `config.toml` and shares Fx's profile,
repositories, and binaries. Plain `fmx` and `--name default` keep the existing
default fmx Session and all of its paths and identity unchanged; names add no catalog or
Runtime lifecycle commands.
