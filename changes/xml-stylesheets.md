### Fixes

- An xml-stylesheet processing instruction loads its stylesheet through the
  proxy, as natively it loads it from the page's origin: one a script puts in
  an HTML or XML document (made, imported from a DOMParser document, its data
  set or edited, moved), another site's sheet included, loaded from the
  address the page wrote, past the service worker (an absolute href) or from
  a route of nothing (a relative one). The PI reads back as the page wrote it
  (`data`, `nodeValue`, `textContent`, its pseudo-attributes, serialized
  markup, `sheet.href`). (xml-stylesheets suite.)
- A text/xml, application/xml or `+xml` document is served through the XML
  shell like an SVG or XHTML one, where it went out raw: its prolog's
  stylesheet styles it, its XHTML scripts run with the proxy's hooks (where
  they read the proxy's address and saw the host as their top), and one
  whose PI
  names an XSLT shows the transform's output, its scripts hooked. A data:
  URL of an XML document gets the XML shell too, and an `<embed>` or
  `<object>` of an XML or SVG document from a blob: URL is rewritten where
  its copy held the page's script as it was. (xml-stylesheets,
  adversarial-local suites.)
- `XMLSerializer.serializeToString(document)` returns the document's
  markup, where it threw ("The node provided is a document").
