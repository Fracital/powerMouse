### Fixes

- `XMLHttpRequest` checks what `open()`, `setRequestHeader()` and `send()`
  are given, as Chrome does, in pages and workers. A method that is no
  token now throws a SyntaxError and CONNECT, TRACE or TRACK a
  SecurityError, before anything of the request changes; only the six
  standard methods are upper-cased (`patch` and custom methods go as
  written, they were all upper-cased). `setRequestHeader` throws a
  TypeError for a missing value or a string that is no byte string, an
  InvalidStateError before `open()` or after `send()`, and a SyntaxError
  for a name that is no token or a value with a NUL or a line break (it
  took them all, or threw an error with no name). `send()` throws an
  InvalidStateError when the request is not opened or was sent already
  (it went out again), and `abort()` of an opened request that was never
  sent fires nothing and leaves it opened. (wpt-xhr-request,
  wpt-xhr-events, wpt-xhr-response.)
