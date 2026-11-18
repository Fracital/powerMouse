### Performance

- The copies of native prototypes the document bundle takes as it loads
  (Node, Element, HTMLElement, SVGElement and the others the hooks read
  the browser's members from) leave out the event handler attributes. No
  hook reads a handler through a copy, and copying them made the getter
  and setter of every handler (some 300 functions) in every frame, which a
  native frame makes only when its page reads one: about 20 KB less heap a
  proxied frame (frame-cost, 20 frames on Chrome 157: 1,116 to 1,119 KB
  before, 1,098 to 1,099 KB after).
