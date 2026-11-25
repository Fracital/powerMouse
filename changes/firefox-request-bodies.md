### Fixes

- In Firefox, a proxied request's body reaches the server again. Firefox has
  no `Request.prototype.body`, so the service worker read every request as
  bodiless and sent each `fetch`, XMLHttpRequest and beacon POST or PUT
  upstream with an empty body (Content-Length 0) since 2026-11-08, and with
  none before. krunk.io's WebRTC signaling was one of them: its gateway
  answered 400 "bad offer", and in Firefox the game fell back from the
  WebRTC data channel to its WebSocket bridge (TCP through wisp) where
  Chrome kept the data channel. Where the getter is missing the worker now
  reads the body whatever it is; a request without one goes out as an empty
  body with Content-Length 0, as a bodiless POST does natively. The Firefox
  smoke page posts a body to the fixture and compares the bytes that
  arrived with its native load.
