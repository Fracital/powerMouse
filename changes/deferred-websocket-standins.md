### Build

- What the WebSocket and WebSocketStream stand-ins do once a page
  constructs one (the URL checks, the transport socket and its events,
  `send()` and `close()`) is a deferred part of the document bundle, in the
  group of the client a document opens its WebSockets with
  (`src/inject/bareClient.ts`), so a document that opens one evaluates
  nothing more than before; the classes stay in the bundle and the worker
  bundle keeps the part. Without the part the construction throws before
  the browser's WebSocket is called (deferred-refusals).
