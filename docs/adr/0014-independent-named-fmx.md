# Names select independent fmx Homes with shared configuration

`fmx --name NAME` selects a Home under `~/.config/fmx/homes/<name>`, giving it
independent Agents, Manifest, UI state, Runtime, Clients, and private sockets,
while every name reads the one root `config.toml` and shares Fx's profile,
repositories, and binaries. Plain `fmx` and `--name default` keep the existing
root Home and all of its paths and identity unchanged; names add no catalog or
Runtime lifecycle commands.
