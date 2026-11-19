### Transport

- A transport without `webTransport` comes back by itself when its wisp
  WebSocket drops while nothing is in flight. epoxy is handed that
  WebSocket as its function transport too, so its close ends epoxy's wisp
  connection and the next request revives the transport. Before, a page
  shown again from the back/forward cache (Chrome closes its WebSockets)
  whose `pageshow` did not reach the controller, and a reset after an
  earlier NAT-style drop, left requests to a pooled site unanswered for
  good. `wisp-idle-drop` covers both, in the worker and in the page.
