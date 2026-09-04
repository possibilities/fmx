# smolmux installs a pinned private Fx

Superseded by [ADR 0016](0016-sessions-are-arbitrary-commands.md): smolmux pins
and installs no program to run inside a Session.

An smolmux checkout pins one approved Fx Integration commit in `fx.json`.
`scripts/install.sh` builds that exact source as the sibling `smolmux-fx`, leaving
the separately managed `fx` untouched. The Runtime resolves and probes Fx once
before constructing the Multiplexer, while every Agent inherits that absolute
path with `FX_AUTO_UPGRADE=0`, so ownership adds no per-Agent lookup or upgrade
path back to upstream Fx.
