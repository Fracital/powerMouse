### Performance

- The client a document opens its WebSockets with (the transport client
  library, `src/transport/RemoteTransport.ts` and what it carries bodies
  with, `src/inject/bareClient.ts`) is a deferred part, evaluated at the
  document's first WebSocket or WebTransport session; the worker bundle
  keeps it. `EventTarget` is one of the snapshots, so the client's socket
  class extends the browser's own even when a page replaced the global
  before its first WebSocket (websocket-close compares that page with
  Chrome). `injectDocument.js` is 6.0 KB smaller.
