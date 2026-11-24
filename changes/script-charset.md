### Fixes

- A script is decoded as Chrome decodes it, by its byte order mark, then
  its Content-Type charset, then UTF-8, not always as UTF-8: a script
  served as windows-1252 reads its non-ASCII characters as natively, and a
  classic or worker script in UTF-16 with a byte order mark runs instead
  of failing to parse (a module is not decoded by one, natively either,
  and takes no charset: Chrome 159 reads a module served as windows-1252
  as UTF-8, as it reads one served as windows-1250) (`src/server/charset.ts`,
  `src/server/rewrites.ts`).
  (script-charset, wpt-workers-constructors, wpt-modules.)
