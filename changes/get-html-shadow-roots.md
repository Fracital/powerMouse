### Fidelity

- `getHTML({ serializableShadowRoots: true })` includes the receiver's own
  shadow root, and a shadow root's `getHTML` the roots of the hosts among
  its children, as natively: both were left out (the receiver was read
  through the browser's Node prototype, which has no `shadowRoot`).
  `Element.prototype.getHTML` of one realm called on an element of another
  (a page's own member on its about:blank frame's element) serializes it
  as natively instead of as a shadow root's children, and a receiver of the
  wrong kind gets the browser's own error (blank-creator).
