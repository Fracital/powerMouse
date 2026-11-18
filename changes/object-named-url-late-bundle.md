### Fixes

- An `<object>`'s HTML document that its page reads while the document's
  bundle is still loading keeps the URL its shell named. The read injects
  the window from the page's bundle, whose new client takes the name; the
  shell's own call then found none and cleared it, so the document read as
  its blob: copy's address (the proxy's, no page's origin) to the page and
  to its own script, whose `location` had no query. A slow bundle made it
  likely: sop-escapes' "csp/an object document" failed on loaded CI
  runners, and in 7 of 12 runs under load-slot. A name taken in the same
  document is kept now.
  (object-documents, with the bundle held back.)
