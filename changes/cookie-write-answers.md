### Performance

- A `document.cookie` write is answered with what it did to the jar (the
  cookie as stored, or its deletion), which the writing document applies
  to the copy it holds, so the read an ad library makes right after each
  write (a probe, then its ids) costs no round trip of its own. Other
  documents of the site still read the jar again, and see the write at
  once (cookie-write-reads suite, compared with native Chrome).
