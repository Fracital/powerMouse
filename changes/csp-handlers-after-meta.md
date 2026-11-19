### Fixes

- A page's handler attributes (onclick, onerror, onload, a body's onload)
  after a `<meta http-equiv="Content-Security-Policy">` in the same piece of
  the markup, or a meta in a later one, ran; Chrome refuses them under a
  script-src without 'unsafe-inline'. A markup handler is now judged as the
  parser inserts it and again as it first runs, by the policies in force
  each time, as natively: one parsed before a meta a script inserts is
  refused as it runs, one never run is still reported, and a report-only
  policy reports each twice.
- A javascript: URL ran under any script-src. It is judged at
  script-src-elem as Chrome judges it, as it runs, and refused runs none
  of its code; a report-only policy reports it twice. The console says
  what Chrome's says of a refused handler and a refused javascript: URL.
  (csp-meta-scripts)
