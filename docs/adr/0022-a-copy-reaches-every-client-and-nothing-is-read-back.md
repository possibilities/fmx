# A copy reaches every Client, and nothing is read back

Extends one clause of [ADR 0021](0021-input-is-part-of-the-control-surface.md):
the socket now carries one thing that is neither input to a Session nor a
Layout, `client.copy`, which puts text on the clipboard of the terminal every
attached Client runs in. Everything else those records decided still holds.

A mouse selection in a Pane already copies through OSC 52: the Runtime writes
the sequence into its own output, and each Client relays the Runtime's bytes
to its terminal without reading them. `client.copy` takes exactly that path
on a caller's behalf. Nothing new crosses the wire, no Client is changed, and
the copy lands where the human is sitting, on the machine their terminal is
on, which is the only clipboard that matters to a human attached over SSH.

The trade-offs are the mechanism's. Every attached Client receives the copy,
because the Runtime renders one byte stream and does not know its Clients
apart. Nothing is kept, so a Client that attaches later gets nothing, and a
copy with no Client attached goes nowhere. Whether a terminal honours the
sequence, and how large a payload it accepts, is the terminal's; the text is
capped like a paste. And there is no read: terminals refuse OSC 52 reads for
good reason, so a program that wants what the human copied reads it where
the human is.

The method is on the Client resource because that is what it reaches. It is
not `session.*`: no Session is involved, and a Session's own OSC 52 would be
its emulator's business.
