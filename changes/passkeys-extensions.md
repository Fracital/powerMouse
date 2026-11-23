### Fidelity

- STomp's passkey provider makes EdDSA (Ed25519) credentials when a site
  lists EdDSA before ES256 and RS256, as Chrome's authenticator picks the
  first of the site's it makes, and signs assertions with them; keeps
  large blobs (the largeBlob extension's `support`, `read` and `write`,
  with Chrome's 2 KiB and one-credential checks and the user verification a
  write needs where the host verifies) and credBlobs (`credBlob` and
  `getCredBlob`, 32 bytes, in the authenticator data as CTAP 2.1 writes
  them); and takes a conditional create (`mediation: "conditional"`) that
  waits silently until the page's timeout or signal, as in Chrome, unless
  the user takes the host's offer (the demo's key button, "Save a
  passkey"). `getClientCapabilities` now says `conditionalCreate`,
  `extension:largeBlob`, `extension:credBlob` and `extension:getCredBlob`,
  as Chrome does. The passkeys-extensions suite compares each natively
  against Chrome's virtual authenticator, in both modes, with every
  ceremony verified by @simplewebauthn/server.

### Demo and API

- `passkeys.onRequest` is now also called with `conditional: true` for a
  `create`: the site offers to save a passkey in the background, so a host
  shows nothing modal, and resolving null leaves the site waiting until its
  own timeout or signal. The demo offers it from its key button.
