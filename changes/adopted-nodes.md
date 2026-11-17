### Security

- A node another parser made (DOMParser, Document.parseHTMLUnsafe, an
  XHR's document) that the page moves into its document with adoptNode or
  importNode, or puts under an element that is not connected, is routed and
  its handlers rewritten before the browser acts on it, open shadow roots
  and templates' content included. Natively its images, media, tracks and
  SVG references load the moment it is in the document and its error
  handlers run without it ever being inserted: those loads left the proxy
  as the page wrote them and the handlers ran unrewritten, with the real
  top. The page still reads its own values back (adopt-nodes,
  adversarial-adopt).
