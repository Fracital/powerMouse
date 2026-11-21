### Fixes

- Shields in standard mode judge a WebSocket or WebTransport session by the
  site of its top-level page, as they judge an HTTP request: a frame of
  another site that opened a socket to its own site was taken for a first
  party, so the lists never judged it, and its socket to the top page's
  site was taken for a third party. A top-level document's sockets are
  judged as before. The adblock-socket-party suite opens both from a page
  and from a frame of another site, in standard and aggressive mode.
- A failed compile of the host's own filters, which standard mode asks of
  first-party requests, is the blocker's `ownError` and no longer replaces
  the engine's `lastError`, which says why the engine itself does not
  serve. Only the inline lists (the custom-filters editor's) are those own
  filters; a list the host names by URL counts as a default list, as
  docs/adblock.md says (a code comment said otherwise; adblock-engine
  checks both).
