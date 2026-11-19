### Fixes

- An `@import` that a page splits across a style's Text nodes loads and
  reads back as natively, its url() or string, its layer(), supports() and
  media included. The browser fetches an import as it parses the text, so
  the pieces could not land as written, and each piece routed on its own
  closed the import where it ended: nothing loaded, and an address written
  in a piece of its own after `@import ` loaded past the proxy. Such a
  style's whole text is now routed and held by its first Text node, the
  others empty, and every Text node, the style's text and its rules read
  back as the page wrote them. What the rule reads after each piece, and
  the requests each piece makes, are Chrome's. (style-text suite.)
