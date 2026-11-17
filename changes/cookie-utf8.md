### Fidelity

- A cookie a server sets with UTF-8 bytes reads as text through
  document.cookie and the Cookie Store API, as Chrome decodes it, where the
  jar showed its bytes a character each; a cookie whose bytes are not UTF-8
  leaves document.cookie empty and reads with an empty value from the Cookie
  Store API, as natively. The Cookie field of a request and of a WebSocket
  handshake reaches the server as the cookie's bytes, where each byte past
  0x7F of a server's cookie, and of a script's past U+00FF, went as two
  (`header-bytes`, `cookie-bytes` suites).

### Known limitations

- A cookie whose bytes are not UTF-8 goes back to its server UTF-8 encoded,
  and a request field a page sets with such a byte arrives empty (Chrome
  hands a service worker such a field as ""): the transports send a field's
  text as UTF-8.
