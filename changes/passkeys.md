### Demo and API

- Passkeys for proxied sites (docs/passkeys.md): STomp is the passkey
  provider itself, as a password-manager extension is, in both controllers
  (the `passkeys` option of `StompController` and `RemoteController`; on in
  the demo in both modes, `?passkeys=off` leaves it out). WebAuthn cannot
  work through the proxy on the browser's own authenticator (it signs the
  proxy's origin and id, which the site rejects), so that authenticator is
  never used for a proxied site. The service worker is the authority: it
  takes the requesting document's origin from its own routed URL, checks the
  relying party id against it by the public suffix list (or the id's related
  origins file, fetched through the proxy; an address is refused at once),
  applies the document's permissions policy, writes `crossOrigin` and
  `topOrigin` for a frame, checks focus as Chrome does (the tab's), and
  makes and signs with keys of its own: ECDSA P-256 (RSA for a site that
  prefers RS256) made by WebCrypto as non-extractable CryptoKeys, in its
  IndexedDB `stompPasskeys`, which no proxied page's hooked IndexedDB
  reaches. `none` attestation, an all-zero AAGUID, BE and BS 0, a zero
  counter. A frame of another origin needs a user activation of its own
  input to create (one the embedding page or the host had is not its own,
  nor is a `UserActivation` the page replaced). `passkeys.onRequest` in the
  host's page asks the user about every registration and sign-in and never
  holds a key; user verification is set only when the host verified the
  user itself (`userVerification`), and the demo does that with the
  platform's own authenticator on its own origin where one is available,
  else sites see none. The page's side reads and refuses requests as Chrome
  does and is a deferred statement of the document bundle's own in the
  rewriter library's file (`__stompPasskeys`, not among the deferred parts),
  compiled only by a document that calls WebAuthn. `controller.passkeys`
  lists, deletes and clears the passkeys, `forgetStorage(origin)` forgets a
  site's with its storage, and the demo lists and deletes them per site
  (Shields, Passkeys) and asks in a keyboard-driven sheet like Chrome's that
  ignores input for its first 500 ms. Their safety is the inject's
  containment, as that of a site's storage and cookies on the proxy origin
  is: a page that escapes the inject can use them, but cannot copy a key off
  the machine. Without the option a proxied page still never reaches the
  browser's authenticator. (passkeys suite: a relying party that verifies
  every ceremony itself and with @simplewebauthn/server, natively against
  Chrome's virtual authenticator and through both demo modes;
  passkeys-safety; adversarial-passkeys; webauthn-related-origins with the
  provider off and on.)

### Known limitations

- Passkeys made through STomp are this browser's and this proxy origin's:
  not synced, without attestation, no security keys or phones, no large
  blob (docs/passkeys.md, "What remains"). WebAuthn with a site's own relying
  party id now works through the provider; without it, it is refused before
  the browser asks anything, as before.
