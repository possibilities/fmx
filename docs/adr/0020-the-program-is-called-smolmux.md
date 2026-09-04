# The program is called smolmux

fmx is renamed to smolmux, in the repository, the directory, the remote, and
every reference across the fleet. The old name described an orchestration
surface for one coding agent; the program that exists now renders any command
and knows nothing about what it runs, so the name outlived what it named.

Every earlier decision record in this directory was written about fmx and
reads as smolmux now, because they are records of the same program. This one
is the only place the two names are connected.

The rename reaches further than prose. The binary, the `SMOLMUX_*`
environment, `~/.config/smolmux`, the `/tmp/smolmux-<uid>` private directory,
the Companion session prefixes `smolmux-<instance>-<name>` and
`smolmuxr-<instance>`, and the `smolmux-zmx` companion binary all move
together. Session names are the record adoption reads, so a Session running
under the old prefix is not adopted by the new name: the rename is done with
nothing running, and any survivor is ended by hand.

Two names stay behind, both the fork's rather than ours. The Companion
reports a build string of `<version>+fmx.<commit>`, and the fork's `build.zig`
refuses a version naming fmx unless `-Dcompanion` was passed — the guard that
stops a stock build passing the pin and then keeping a human's own sessions in
the wrong directory. Renaming that marker here would bypass the guard, so it
waits for a fork change and a pin move. The fork's `-Dcompanion` default
directory is likewise still `/tmp/fmx-<uid>/zmx`, so a by-hand
`smolmux-zmx list` does not find smolmux's own sessions; `smolmux doctor`
prints the command with the directory named rather than leaving that to be
discovered.

The cost of renaming rather than aliasing is that nothing answers to `fmx`
any more: no shim, no compatibility path, no reader for the old config
directory. That is the same forward-only choice every other vocabulary change
in this repository made.
