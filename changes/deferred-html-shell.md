### Build

- The HTML shell writer (`src/htmlShell.ts`: `modifyHTML`, the statements
  it writes for the client, the gap view's script and the `entities`
  escaper) is a deferred part of the document bundle, made at a document's
  first srcdoc, object or embed document, data: document or javascript:
  URL markup that no worker serves; the XML shell is in its group, and the
  service worker and the worker bundle keep it. Without the part an srcdoc
  is not set, a data: frame is not navigated, a data: URL's document is an
  empty one and a javascript: URL's markup throws, never the page's markup
  unrewritten (deferred-refusals).
