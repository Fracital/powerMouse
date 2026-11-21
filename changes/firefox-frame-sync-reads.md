### Fixes

- In Firefox a proxied frame's synchronous reads (document.cookie,
  localStorage, a synchronous XMLHttpRequest) answer at once. Each one
  reached the bridge's 10 s limit and threw a RangeError: the ask for the
  answer (src/inject/dom/syncAnswer.ts) is a deferred part, and the spin
  took it only where the document held the parts already, which a frame
  never does. Where the worker has not said the browser sends that ask
  past it, the spin now makes the part from its top's text (never a
  request for the file). Chrome, whose worker says so, is unchanged.
  (sync-engines, npm run test:firefox.)
