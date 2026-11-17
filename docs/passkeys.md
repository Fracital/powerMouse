# Passkeys through the proxy

**Measured 2026-11-17 against Chrome 157, with Chrome's virtual authenticator
(CDP WebAuthn) as the oracle** (the passkeys, passkeys-safety,
adversarial-passkeys and webauthn-related-origins suites).

Short version: the browser's own WebAuthn cannot work through an
origin-rewriting proxy, so STomp is the passkey provider for proxied sites
itself, the way a password-manager extension is. The keys are partitioned per
site the way a site's storage is, the service worker decides who asks and
signs, and the host application asks the user. Its safety rests on the
inject's containment, as that of every proxied site's cookies, storage and
service-worker cookie jar already does. A host that gives the controller no
`passkeys` option gets no provider, and proxied pages then still never reach
the browser's own authenticator.

## Why the browser's own WebAuthn cannot work

A proxied page runs on the proxy's origin, not the site's. WebAuthn binds a
credential to a relying party id that the browser checks against the
document's origin, signs that origin into the client data
(`clientDataJSON.origin`), and has the authenticator sign the SHA-256 of the
relying party id (`rpIdHash`). Prefixing or rewriting names on the browser's
real WebAuthn cannot fix that: the browser would sign the proxy's origin and
the proxy's id, and the site's server rejects both. A request the browser did
accept would make or use a credential scoped to the proxy's one real origin,
which every proxied site shares. So the browser's own authenticator is never
used for a proxied site's credential, with or without STomp's provider.

## What STomp supports

With the controller's `passkeys` option (on in the demo, both modes), for
every proxied site on a secure origin:

- `navigator.credentials.create({ publicKey })`: discoverable and
  non-discoverable credentials (`residentKey`, `requireResidentKey`),
  `excludeCredentials` (the site is told `InvalidStateError` only after the
  user agrees, as WebAuthn 6.3.2 says), `pubKeyCredParams` in the site's order
  (ES256, and RS256 when the site lists it first), attestation `none` whatever
  the site asks, `credProps` and `prf`;
- `navigator.credentials.get({ publicKey })`: by `allowCredentials` or a
  discoverable credential, `userVerification`, conditional mediation (the
  demo offers the passkey from a key button in its address bar while the
  tab's site waits, and never shows a sheet for it), `prf` (`eval`,
  `evalByCredential`), the `appid` extension's origin check;
- timeouts and `AbortSignal`, one request at a time per document ("A request
  is already pending."), the user activation a frame of another origin needs
  to create, the focus check (of the tab, as Chrome's: a frame asks while the
  focus is anywhere in its top's page);
- `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable`,
  `isConditionalMediationAvailable`, `getClientCapabilities` (answered for
  STomp's authenticator, in a later task as Chrome answers them),
  `signalUnknownCredential`, `signalAllAcceptedCredentials`,
  `signalCurrentUserDetails` (they change what STomp holds, without a prompt),
  and the browser's own `parseCreationOptionsFromJSON`,
  `parseRequestOptionsFromJSON` and `toJSON`;
- Chrome's error types and messages for every malformed or refused request,
  read in Chrome's member order (measured case by case against the virtual
  authenticator; the passkeys suite compares them on every run).

What a page gets is the browser's own `PublicKeyCredential`,
`AuthenticatorAttestationResponse` and `AuthenticatorAssertionResponse`
objects, read through the browser's own getters.

## How it works

**The page** (`src/inject/dom/passkeys.ts`). The inject's Credentials module
hooks `create`, `get` and the statics before any page script runs; STomp's
WebAuthn client is a deferred statement of the document bundle's own (after
the deferred parts' in the rewriter library's file, not among them),
evaluated with a document's first call, so a frame that never asks neither
carries nor compiles any of it, and no call reaches the browser's own
WebAuthn in between. It reads the request as
Chrome's bindings do and refuses what Chrome's renderer refuses, then posts
the request to the service worker with a private port for the answer.

**The service worker is the authority** (`src/server/passkeys.ts`,
`src/passkeys/rpId.ts`). It never takes the page's word for who asks:

- the requesting document's origin is the sender's own routed URL
  (`event.source`, a `Client` the browser fills in), its emulated origin;
- the relying party id must be that host or a registrable suffix of it, by the
  public suffix list (tldts, private section included: `github.io` is no
  relying party id, `pk-a.github.io` is one), or be listed by the id's own
  `/.well-known/webauthn` (related origins, fetched through the proxy as
  Chrome fetches it, never by the browser);
- the permissions policy (`publickey-credentials-create`,
  `publickey-credentials-get`) is the one the worker recorded for that
  document, with its frame's `allow` attribute;
- `crossOrigin` and `topOrigin` come from the document's route (a frame's
  route names its top).

So a site can never create, list, sign for or detect another site's
credentials: a request names nothing the worker uses for scoping.

**The host confirms** (`src/passkeys/host.ts`, `passkeys.onRequest`). Every
create and every get goes to the host application's page through the
controller, with the relying party id, the requesting origin and its top, the
account, the passkeys that may answer and an abort signal. Nothing is made or
signed before it resolves. The demo shows a sheet like Chrome's passkey sheet,
in its own page where no proxied page can click: it names the site and the
account, is a modal dialog the keyboard can drive (Tab stays in it, Escape
cancels), and its buttons ignore input for 500 ms after it shows so that a key
or click meant for the page cannot confirm it. Nothing confirms by itself.

**The authenticator** (`src/passkeys/authenticator.ts`, in the service
worker). Keys are WebCrypto ECDSA P-256 (or RSA 2048 for RS256) pairs made
with `extractable: false`, kept in the worker's own IndexedDB database
`stompPasskeys`, keyed by credential id with an index on the relying party
id, with the user handle, the account's name and display name, whether it is
discoverable, and when it was made and last used. The inject suffixes every
database name a proxied page opens with its storage key (`name@<storage
key>`), so no hooked path reaches that name, as none reaches the cookie jar's
`stompCookies`. Signing happens in the worker; a page receives only the
response. What the worker writes:

- `clientDataJSON`: `type`, `challenge`, `origin` (the emulated origin),
  `crossOrigin`, and `topOrigin` when cross-origin, in Chrome's member order
  and compact serialization, with Chrome's extra member one time in five;
- authenticator data: `rpIdHash` = SHA-256 of the real relying party id;
  flags UP, UV only when the user was really verified (below), BE and BS 0
  (the keys are not synced), AT on a registration; signature counter 0;
- attestation `none` (`fmt: "none"`, an empty `attStmt`) and an AAGUID of
  zeros, as Chrome gives for providers that do not attest.

## User verification: real or none

A site is told the user was verified (the UV flag, and
`isUserVerifyingPlatformAuthenticatorAvailable() === true`) only when the
host says it verifies users itself (`passkeys.userVerification: true`) and
then answers `userVerified: true` for the ceremony. A click in a sheet is user
presence, never verification.

The demo verifies for real when it can: before its controller starts it asks
the platform whether a user-verifying platform authenticator is available on
its own origin (which must be a domain, since an address is no relying party),
and if so it declares `userVerification`. When a site does not discourage
verification, after the user confirms in the sheet the demo runs a WebAuthn
ceremony of its own, on its own origin, with `userVerification: "required"`
(the first time it makes a credential of its own, "STomp passkeys", and asserts
it after), and answers `userVerified` only when the browser's own
authenticator data says UV. The proxied page never sees that ceremony, and
the a8ac29f2 rule below keeps proxied pages from reaching that credential. On
a machine without a platform authenticator, or a demo on an address, the
option is left out: sites see no user-verifying authenticator and get no UV
flag, and a site that requires verification falls back as it does natively on
such a machine (its create or get is refused, as Chrome refuses it when no
authenticator can verify). This was chosen over a fixed answer either way: a
fixed "verified" would be a lie a site relies on, and a fixed "not verified"
would refuse many sites that a real platform could serve.

## The host's controls

`controller.passkeys` (StompController and RemoteController) lists the held
passkeys (no key material), deletes one by id, and clears every one or those
of a relying party. `controller.forgetStorage(origin)` forgets a site's
passkeys with its storage: every one whose relying party id is the site's host
or a suffix of it. The demo lists and deletes them per site in its settings
(Shields, Passkeys), and its "Forget me when I close this site" shield clears
them with the rest of the site's data. `cookies.clear()` leaves them.

## Threat model: containment, as storage

The proxy serves every site from one real origin. What keeps one proxied
site's localStorage, IndexedDB, cookies and service-worker cookie jar from
another is the inject's containment: every hooked path a page can reach maps
its names into the site's own partition. STomp's passkeys rest on exactly the
same thing. The user's decision (2026-11-17): "this is NO different than
prefixing localStorage".

Against a page that stays inside the inject's hooks, which is every page the
proxy serves, the provider fails closed (the adversarial-passkeys suite):

- site B asking for site A's relying party id is refused with Chrome's
  `SecurityError` before any prompt, and so are public and private suffixes as
  ids (`co.uk`, `github.io`, `com`) and addresses (`127.0.0.1`, `[::1]`),
  which are refused at once, with no related origins request;
- a frame of another site gets the permissions policy's refusal without
  `allow`, needs a user activation to create, and with both the client data
  says `crossOrigin: true` and its top, and the sheet says it is in a frame.
  The activation must come from the frame's own input: every proxied
  document is of the one proxy origin, which the browser lets share an
  activation, so one in the embedding site's page or the host's address bar
  does not count, nor does a `UserActivation` the page replaced;
- a message to the worker shaped like the inject's, posted from a proxied page
  through anything it can reach (parent, top, opener, the emulated service
  worker, a BroadcastChannel, a shape like the controller's RPC) never
  reaches the worker as a request, and if it did the worker would take the
  origin from the sender;
- a replayed response fails at the relying party (a challenge is good once,
  and the origin and `rpIdHash` are the real site's);
- whether a passkey is held is not told by error or timing: a get with an id
  STomp holds and one it does not end alike until the user acts, and an
  excluded credential is said only after the user agrees.

A page that escapes the inject (runs the browser's own natives in the real
document, bypassing every hook) holds the proxy origin, as every proxied page,
the controller frame and the service worker do. It can then, as it can with
every site's cookies and storage on that origin:

- drive another proxied site's tab, or forge a ceremony to the host from the
  controller frame (escape cases A3 and A4 of the earlier review), and obtain a
  real assertion for a site the user holds a passkey for, behind one host sheet
  that names that site;
- open the worker's `stompPasskeys` database itself and sign with a key
  directly, without any sheet.

The browser gives no way to tell such a page from the proxy's own parts: the
worker gets no frame ancestry (`WindowClient.ancestorOrigins` is absent on
Chrome 152, 156 and 157, measured), a service worker cannot post to the host's
origin, and every proxy-origin window shares one origin. Only per-site proxy
origins would put a browser-enforced boundary there, and STomp does not use
them (one origin, sites emulated in it).

What non-extractable keys buy: an escaped page can use a key only while it
runs in this browser, through WebCrypto; it cannot read the private key's
bytes, so it cannot copy a passkey off the machine and use it later or
elsewhere. Closing the page ends what it can do with them. The keys are not
safer than that against an escape, and are not meant to be.

## Without a provider

A host that gives the controller no `passkeys` option (the demo's
`?passkeys=off`) gets no provider, and a proxied page's requests end as in a
browser that holds no passkey for the site. The browser's own WebAuthn is
still kept from acting for a proxied page (since a8ac29f2, unchanged): a
relying party id the browser would accept for the proxy origin (its own host
or a registrable suffix) is handed the browser empty, read where and when the
browser reads the page's so member order and the synchronous `TypeError`s stay
Chrome's, and the browser refuses it before consulting any authenticator;
that refusal is reshaped into Chrome's `NotAllowedError` for a create or get,
and the no-op a signal is. A get with no relying party id (the proxy origin's
own, by default) is refused the same way. With the provider, a `publicKey`
request never reaches the browser at all, and the same guard stays in front of
the browser's own `create` and `get` for every other kind of request.

## The related origins leak

A relying party id that is neither the document's host nor a suffix of it
makes Chrome fetch `https://<id>/.well-known/webauthn` from its own process
(WebAuthn's related origins, 5.11.1), with nothing of the proxy in the way.
The inject hands the browser an id it refuses without a fetch and gives the
refusal Chrome's words for a file that could not be fetched (the
webauthn-related-origins suite). With the provider, the worker fetches that
file through the proxy itself, with Chrome's headers and no cookie, referrer or
origin, so related origins work as natively.

## What remains

- The passkeys are this browser profile's and this proxy origin's: not synced,
  not backed up (BE and BS are 0, which is true), lost when the proxy origin's
  site data is cleared, and not interchangeable with a passkey registered
  natively (a site sees a new authenticator).
- No attestation: a site that requires certified attestation (some enterprise
  relying parties) refuses STomp's `none`.
- No security keys or phones (hybrid): `authenticatorAttachment:
"cross-platform"` finds no authenticator, as on a machine with none.
- No large blob, no `credBlob`, no conditional create (`mediation:
"conditional"` on create is refused), no EdDSA.
- User verification only where the host can make a real one (above).
- The containment limits above: an escape of the inject reaches the passkeys
  as it reaches the cookies and storage.

## What this is measured by

- **passkeys**: the harness page (test/pages/passkeys.js) natively against
  Chrome's virtual authenticator and through the demo in both modes, against a
  relying party (test/passkeys-rp.mjs) that verifies every registration and
  assertion twice, by its own steps and with @simplewebauthn/server; compared:
  interfaces, statics, member read order, every malformed and refused request,
  every field of each credential and assertion, frames with and without the
  policy, user activation, related origins, timeouts and aborts, conditional
  mediation, the host's sheet, the store and its key's extractability, and that
  the browser's own authenticator holds nothing for a proxied site.
- **passkeys-safety**: with and without the provider, no proxied page creates,
  lists or asserts a credential on the shared proxy origin.
- **adversarial-passkeys**: the containment cases above, in both modes, against
  native Chrome's answers.

They need no device, GPU or network and run on the CI runner.
