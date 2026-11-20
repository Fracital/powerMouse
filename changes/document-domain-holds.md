### Security

- A document that sets document.domain alone no longer keeps reaching a
  window of its origin because something read that window before the write.
  A frame's window remembered every window read through its getters while
  the two documents reached each other, and handed it out raw from then on
  without asking again. That read did not have to be the page's: the demo
  host reads a frame's `parent` chain whenever the frame hands it a key, so
  after a frame had sent the host Escape, Alt+arrow or Ctrl+Shift+X, a
  frame that set document.domain alone (or whose parent did) still read
  its parent's document, globals and location, where Chrome throws
  SecurityError. Once either document has set document.domain, a window the
  frame held is judged again on every read and handed out as a stand-in
  when the two no longer reach each other. The record of held windows a
  popup starts again with, when its document becomes another origin's, is
  also one whose methods a page cannot replace, as the first one was.
  (agent-cluster: two scenarios walk every frame's parents from the
  outermost page between the steps, as the host does.)

### Demo and API

- The demo finds which tab a forwarded key came from by searching each
  tab's frames down by index, no longer by walking up the sending frame's
  `parent` chain, whose reads ran that frame's own getters.
