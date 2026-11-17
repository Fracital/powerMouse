### Fidelity

- A cookie named as one of Object.prototype's members (`constructor`,
  `toString`, `__proto__`, `valueOf` and the others) is kept, from a
  Set-Cookie header and from document.cookie, and sent back, as Chrome does:
  the jar used to drop it. The jar parses a Set-Cookie value itself instead
  of with set-cookie-parser, which also takes 2.3 KB out of the document
  bundle and the service worker (suite cookie-names).

### Dependencies

- `set-cookie-parser` is no longer a dependency: the cookie jar parses a
  Set-Cookie value itself (`parseSetCookie`, `src/server/Cookies.ts`).
