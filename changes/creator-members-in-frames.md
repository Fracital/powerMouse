### Fidelity

- A page's own markup members called on an element of an about:blank
  frame it made (`Element.prototype.setHTMLUnsafe` called on the frame's
  element, appendHTMLUnsafe, the innerHTML setter, insertAdjacentHTML)
  parse as the frame's document's, as natively: its images load (they
  were given routes the frame cannot load) and the nodes are of the
  frame's realm. An image the page made and put in such a frame loads
  too (blank-creator).
