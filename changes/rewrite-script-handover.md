### Performance

- A script's bytes are handed to a rewrite worker rather than copied, and
  the worker answers with a Blob it made of its output where the output
  stands in the module's memory, which the service worker serves as it is.
  The service worker made a copy of the bytes going and copied the
  output's bytes into a Blob of its own coming back. In Chrome 157 its
  thread spends 1.2 ms on the site corpus's twelve largest scripts where
  it spent 108, and they are rewritten in 5% less time end to end. A
  worker that never answers (its page closed, or it took too long) still
  leaves the service worker the bytes to rewrite itself.
