### Fidelity

- A proxied WebSocket checks its arguments and states as Chrome does, in
  its words: the constructor refuses a subprotocol that is no token or is
  there twice with a SyntaxError (after the URL's checks and a policy's
  refusal, before mixed content), `close()` converts its code as a
  `[Clamp] unsigned short` (cut off, never rounded) and throws
  InvalidAccessError outside 1000 and 3000-4999 and SyntaxError for a
  reason over 123 bytes, `send()` while connecting throws
  InvalidStateError, a string sent or a reason given with a lone surrogate
  goes with U+FFFD, and an argument that does not convert is refused with
  Chrome's TypeError. A `close()` while connecting reads CLOSING at once
  and fails the connection a task later (error, then close 1006, not
  clean), where it read CONNECTING and waited for the open. 207 subtests
  of `wpt-websockets` pass that failed (`constructor/004` alone 161), and
  `websocket-close` compares the refusals with Chrome's.
