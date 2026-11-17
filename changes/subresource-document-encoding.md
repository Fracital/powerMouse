### Fidelity

- A classic script or a stylesheet that names no encoding (no byte order
  mark, no Content-Type charset, for a sheet no `@charset`) is decoded with
  its document's encoding, as natively, not as UTF-8: a Shift_JIS page's
  script served as `text/javascript` reads its Japanese strings instead of
  U+FFFD, and its sheet's `content` likewise. The worker keeps each legacy
  document's encoding by its client id (`src/server/documentEncodings.ts`;
  a restarted worker forgets it and reads such a resource as UTF-8). A
  script element's `charset` attribute, which Chrome reads before the
  document's encoding, is not carried to the worker yet.
  (document-encoding.)
