# fmx installs a pinned private Fx

An fmx release pins one approved Fx Integration commit in `fx.json`, carries
that file in its immutable archive, and has its public installer obtain that
exact native build as the sibling `fmx-fx`, leaving the separately managed
`fx` untouched. The Runtime resolves and probes Fx once before constructing
the Multiplexer, while every Agent inherits that absolute path with
`FX_AUTO_UPGRADE=0`, so ownership adds no per-Agent lookup or upgrade path back
to upstream Fx.
