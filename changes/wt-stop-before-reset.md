### Fidelity

- A WebTransport server that closes as webtransport-go does, its streams
  stopped and reset first, now errors the page's writable before its
  readable, as Chrome does. The reset reached the page first in about one
  run of ten: the stand-in heard the reset a step before the stop in the
  same turn. A stream's reset now waits one task while its writable is
  still open, and the session's close waits for it.
