### Fixes

- A worker's `importScripts()` of a script of another origin (fetched
  without CORS, or redirected there) throws a NetworkError naming the
  script's URL, whatever the script threw or failed to parse, as natively:
  the error the page sees and its uncaught report carry the importing
  script's position and nothing of the script's. It threw the script's own
  error. An error of a script of the worker's own origin leaves the
  browser's call untouched again, so its uncaught report names that script
  and its line (a syntax error at `syntax-error.js` line 1); since the
  hook caught and rethrew every error, it was reported where the page
  called `importScripts()`. (wpt-workers-semantics: importScripts catch and
  report-error pages; wpt-workers-basics:
  Worker-nested-importScripts-error.)
