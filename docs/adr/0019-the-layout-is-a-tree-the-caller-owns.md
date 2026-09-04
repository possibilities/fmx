# The Layout is one tree the caller owns, with a revision

The Layout is a tree of rows and columns whose leaves are Panes, applied
whole. Sizes live in the tree, so resizing a Pane is applying a tree with a
different size and there is no resize verb. Geometry is fmx's own: every Pane
is absolutely positioned at the rectangle the fitter computed, so one apply
is one layout pass, and a Pane that keeps its rectangle is not resized at all
— its emulator neither reflows nor tells its PTY anything, so a Session that
stays on screen across an apply never blinks.

The alternative was a verb per surface, which is what agentmux has over tmux:
`left.resize`, `dock.zoom`, `right.hide`. It reads well for one surface and
sprawls with the second, and it forces fmx to know what each surface is for.
One tree means a new arrangement is a new tree, zoom is just a tree where one
Pane takes the remainder, and fmx never learns the word "panel".

A tree the caller owns is read-modify-write, and a human dragging a divider
writes to it too. So the Layout carries a revision, moved on by every apply
and every drag; a caller passes back the revision its tree was built from and
a stale write is refused as a conflict. Omitting it writes unconditionally,
which is what a caller with no human in the loop wants.

Before anyone applies a Layout there is nothing for fmx to draw but its own,
so it composes one from the roster — the first Session, or the empty line —
until the first apply takes ownership. The alternative, holding the startup
Layout fixed, means a human attaching to an unarranged Instance reads "no
sessions" while three are running. Ownership is one-way: once a caller has
applied a Layout, the roster never moves it again.

The costs: reacting to a drag is a whole-tree read rather than "this divider
moved by four", because Panes have no identity in the API beyond their
position in the caller's own tree. And a caller that ignores the revision can
still clobber a drag — the guard is offered, not imposed.
