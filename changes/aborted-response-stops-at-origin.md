### Fixes

- A response the page gives up stops at the origin. An aborted `fetch`, a
  cancelled body or a document that went away ended the page's copy only: a
  response the HTTP cache or the memory cache would keep was teed, and the
  cache's copy read on to its entry limit (5 MB, 24 MB), on a stream that
  never ends for ever, so the origin kept sending what nobody read (an
  aborted download, a media range dropped by a seek, a stream the page
  stopped). The cache's copy now follows the page's: the body is read as the
  page reads it and ends when the page lets go, and nothing is kept of it; a
  short body of a known length (64 KiB) is still read whole. (wpt-fetch-abort,
  http-cache suites.)
