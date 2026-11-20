### Fixes

- A fetched response's headers are immutable again, as Chrome's are:
  `append`, `set` and `delete` throw "Headers are immutable" (after the
  arguments are checked, as natively). The inject shows the page a copy of
  an answer's headers without the worker's own Server-Timing metrics, and
  that copy, like the empty headers of an opaque answer, took changes the
  native object refuses. Since stomp-protocol marks nearly every answer from
  the network, nearly every response read that way (wpt-fetch-objects,
  response-headers-guard).
