### Fidelity

- A proxied page's WebTransport reads its options in Chrome 158's order:
  the anticipated counts of the server's bidirectional and unidirectional
  streams before `headers`, each converted and refused in Chrome's words,
  where the browser's own constructor reads them (Chrome 157 and older
  read neither). A session reads them back and may set them, and has
  Chrome 158's `reliability`, `draining` and `responseHeaders` (an empty
  immutable `Headers` once up: stomp-h3 does not hand over the server's
  fields), where the browser has them; before, each answered a proxied
  session as it answers something that is no session ("Illegal
  invocation"). `webtransport` and `webtransport-live` compare them
  natively.
