# Control socket beside the agent socket

fmx exposes its command surface over a second Unix socket (`/tmp/fmx-<pid>.ctl`, `FMX_SOCKET_PATH`) rather than extending the agent socket, because the agent socket speaks fx's protocol and must reply before it acts — fx blocks its send path on that reply — while a command needs its result and may wait. The control socket is fmx's own wire, one request per connection, mode 0600; the same `fmx` binary is its client, so an agent inside an instance needs nothing installed beyond what started it.
