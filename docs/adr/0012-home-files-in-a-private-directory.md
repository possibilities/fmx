# fmx Session files live in a private directory

fmx binds each fmx Session's ADE socket, Runtime bridge, and singleton lock inside
`/tmp/fmx-<uid>`, created 0700 and refused when it is not ours or is open to
others, rather than placing its own names directly in world-writable `/tmp`.
A Runtime unlinks its sockets when it exits, while Companion-held Fx processes
can outlive it; a name in `/tmp` could therefore be taken by another user and
receive lifecycle records whose Fx Conversation titles summarize prompt text.

Moving the sockets blacks out lifecycle for Agents that survive this upgrade,
because they retain the old paths they received at launch. They keep running
under the Companion and can be adopted, but their ADE records and Runtime-bridge
requests resume only after they are relaunched with the private-directory paths.
