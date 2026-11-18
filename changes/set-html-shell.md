### Fidelity

- What `setHTML`'s sanitizer leaves in a declarative shadow root, and in a
  template's content when the element is a `<template>`, is routed like
  the rest: it went in as the page wrote it (a shadow root's image loaded
  from the proxy's own origin and failed, its link led there). A page's own
  `Element.prototype.setHTML` called on an element of its about:blank
  frame makes nodes of the frame's realm, as natively, not of the page's
  (blank-creator).
