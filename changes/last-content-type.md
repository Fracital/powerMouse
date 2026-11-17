### Fixes

- A response with two Content-Type values is read by the last value that
  is a type, as Chrome reads it (Fetch's "extract a MIME type", a charset
  carried over from an earlier value of the same type), not by the first:
  a script served as application/octet-stream and then text/javascript
  runs through STomp as it does natively (`src/server/filterHeaders.ts`).
  (dup-content-type, wpt-workers-semantics.)
