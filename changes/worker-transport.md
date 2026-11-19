### Fixes

- A document no service worker controls finds a transport, as its beacons
  and fetches do: an about:blank frame (from its parent or its own script,
  one or two levels down), a frame the parent wrote and an about:blank
  popup (through its opener) start workers whose WebSockets connect and
  open WebSockets of their own, where they logged "Stomp: could not
  provision a transport for a worker" and their sockets threw or never
  opened. A blob: worker of such a document is started by the nearest
  controlled document's Worker, so its imports and fetches reach the
  service worker (its bootstrap failed to load), and it ends when its
  document goes. A worker's own workers get a transport from it (they had
  none: a worker has no service worker to ask). A WebSocket of a frame
  whose window its parent's bundle hooked hands its events, Blobs and
  ArrayBuffers of the frame's own realm. Web-platform-tests
  `websockets/multi-globals/message-received.html` passes. (worker-realms.)
