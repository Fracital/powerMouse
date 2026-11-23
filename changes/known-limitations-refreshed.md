### Known limitations

- WebRTC now sends comfort noise with G.711 and G.722 (`src/rtc/cng.ts`),
  plays a lost Opus packet from the next packet's in-band FEC copy, and
  carries TURN over TCP and TLS and ICE-TCP candidates
  (docs/webrtc-over-wisp.md). What is left of those gaps: `getStats()` has
  no entries for video (the `codec`, `inbound-rtp` and `outbound-rtp`
  entries are the sound's only), and the FEC copy of a hybrid Opus packet
  is decoded as wideband SILK, while the copies in stereo, 40 ms or 60 ms
  packets go unused. This replaces the item further down this section that
  says comfort noise is not sent, FEC copies are not used, TURN over TCP or
  TLS and TCP candidates are not carried, and `getStats()` has no media
  entries.
- Withdrawn: in the item further down this section on error surfaces, the
  sentence that says a page's CSP is not forwarded and no
  `securitypolicyviolation` fires. The page's policy is enforced and its
  violations reported as the page's own (docs/csp.md, the `csp-*` suites).
  A classic script of another origin that a worker imports mutes its errors
  as natively too (wpt-workers-semantics). The rest of that item holds.
- Withdrawn: the item further down this section that says aborting a fetch
  does not cancel the request on the transport. An abort before the headers
  cancels the request, and a body the page gives up stops at the origin
  (abandoned-bodies, wpt-fetch-abort, http-cache suites).
- Withdrawn: the item further down this section that says
  `getSVGDocument()` is not spoofed. It is hooked on frames, objects and
  embeds and hands out the document as `contentDocument` does
  (`src/inject/dom/modules/IFrame.ts`).
- Withdrawn: the item further down this section that says WebAuthn with
  the real site's `rpId` fails. STomp's passkey provider answers those
  ceremonies (docs/passkeys.md), with the site pool on too; what it still
  lacks is this section's item on passkeys made through STomp.
- Array destructuring patterns (`const [{ top }] = [w]`) are resolved by
  the access API now (rewriter-differential). A nested pattern's default
  value (`{ a: { top } = w }`) still reads the real value. This replaces
  the item further down this section that names both.
- The code of a `blob:` worker is rewritten now: its bootstrap imports the
  page's Blob through the service worker. A classic `blob:` worker whose
  document's policy refuses `blob:` scripts still runs the page's code
  unrewritten after the bootstrap's preamble. Worklet modules get no
  inject, and an HTML blob built from another Blob is shown as it is. This
  replaces the item further down this section that says a `blob:` worker's
  code is not rewritten.
- A WebSocket handshake through epoxy offers no `permessage-deflate`
  (Chrome does): epoxy's WebSocket library refuses compressed frames, so an
  offer the server took would break the socket. The rest of that item no
  longer holds: the handshake's field names are spelled as Chrome spells
  them (`Sec-WebSocket-Key`), it carries `Accept-Language` from the user's
  languages, and epoxy's HTTP requests offer
  `Accept-Encoding: gzip, deflate, br, zstd` (deploy/epoxy patches hyper
  0050, epoxy-tls 0009 and 0052).
  This replaces the item further down this section about the handshake.
- Withdrawn: the item further down this section that says a header value
  with bytes past 0x7F reaches the page encoded as UTF-8 a second time. The
  page reads the site's bytes, a code unit each (header-bytes suite).
- An import map's targets are routed now, its trailing-slash prefixes too
  (`src/scriptRoutes.ts`). Its scope keys stay as written, so a scoped
  override falls back to the global mapping, and its integrity keys stay
  inert. This replaces the item further down this section that says the
  map's own URLs are not rewritten.
