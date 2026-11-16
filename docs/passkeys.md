# Passkeys through the proxy

**Measured 2026-11-16 against Chrome 157, with Chrome's virtual authenticator
(CDP WebAuthn) as the oracle** (passkeys-safety suite).

Short version: WebAuthn cannot be made to work safely through an
origin-rewriting proxy that serves every site from one real origin. STomp
therefore offers no passkeys. What it does is make sure no proxied page can
create, list or assert a credential on that shared origin, so one proxied site
can never use what another made, and the refusal reads as a browser's own.

## Why the browser's own WebAuthn cannot work

A proxied page runs on the proxy's origin, not the site's. WebAuthn binds a
credential to a relying party id that the browser checks against the document's
origin, and signs that origin into the client data the site's server verifies.
A site's relying party id is its own domain, which is never the proxy's, so:

- a request for the site's own relying party id is refused (on an address proxy
  origin with "This is an invalid domain.", on a domain proxy origin after the
  browser has tried the site's `/.well-known/webauthn` itself, which the inject
  already stops leaking: see "The related origins leak" below);
- a request the browser did accept would make or use a credential scoped to the
  **proxy's** origin, which the site would reject, and which every other proxied
  site shares.

That last point is the danger this document is about. On a domain proxy origin,
`navigator.credentials.create({ publicKey: { rp: { id: <proxy host> } } })`
succeeds in the browser's own WebAuthn and plants a real passkey for the proxy
origin. A different proxied site, on the same proxy origin, can then assert it
with `navigator.credentials.get()`. The passkeys-safety suite shows exactly
this on the base build: a proxied create plants a credential (the virtual
authenticator holds one), and a second proxied page's get returns a valid
assertion of it.

## Why STomp does not stand in as an authenticator

The obvious fix is for STomp to be the authenticator itself, the way a password
manager is a passkey provider: hold a key pair per passkey, bound to the site's
real relying party id, in the host application's own origin (which proxied pages
cannot reach), and ask the host's UI about every ceremony. An earlier version of
this feature did exactly that. Review held it, and this is why.

The security of such a design rests entirely on the inject's containment, and
on a single-proxy-origin deployment that containment is not enough.

The attacker is arbitrary script in a proxied page that has escaped the inject
(every hook bypassed, running the browser's own natives in the real document).
Such a page holds the proxy origin, as every proxied page, the controller frame
and the service worker do. What the browser gives each party is not enough to
tell them apart:

- **The service worker** learns which client sent a message (`event.source`, a
  `Client` the browser fills in) and that client's URL, type, `frameType`,
  `focused` and `visibilityState`. It does not learn the client's frame
  ancestry: `WindowClient.ancestorOrigins` is absent on Chrome 152, 156 and 157
  (measured), and a navigation's `FetchEvent` names no parent. It can take the
  requesting document's real origin from that client's own routed URL, which is
  why asking the worker from the attacker's own document for another site's
  relying party id is refused. But it cannot stop a request that comes from a
  genuine client of the victim's site, which the attacker reaches and drives.
- **The host page** (another origin) learns of a message only its `event.origin`
  (the proxy origin, for the worker's relay and for any proxied page alike) and
  its `event.source` window. A service worker cannot post to a window of another
  origin, so everything the worker tells the host arrives through a window of the
  proxy origin (the controller frame), which any proxy-origin page can post from
  in that window's own realm. The host cannot tell the worker's relay from a
  forged message.
- **Same-origin script** reaches every window of the proxy origin: in isolation
  mode a proxied top's `parent` is the host's window, whose `frames` (readable
  across origins) are every tab and the controller frame.

So an escaped page can obtain a real assertion for any relying party the user
holds a STomp passkey for, behind one host prompt that names that relying party,
either by driving the victim site's own tab (the worker sees a genuine client)
or by forging the ceremony to the host from the controller frame (the host
cannot tell it from the relay). These are escape cases A3 and A4 in the review.
Making the worker the sole authority by client id closes neither: A3's client is
genuine, and A4 never reaches the worker. No authenticated channel helps,
because any secret has to pass through a proxy-origin window to reach the worker,
and the worker keeps nothing across a restart. The only thing that closes it is
an origin boundary the browser enforces between a relying party's pages and every
other proxied site, which is per-site proxy origins, which this deployment does
not have.

A host could narrow the risk at a steep usability cost by binding a ceremony to
the one site the user typed into its own address bar for that tab and refusing
every other, which refuses every sign-in reached by a link, single sign-on
among them. That is a product decision for a specific deployment, not a safe
default, and it is not what STomp ships.

## What STomp ships: a safe refusal

Since no credential STomp could offer is safe on one real origin, STomp offers
none, and makes the absence tamper-proof: **no proxied page ever creates, lists
or asserts a credential on the proxy's real origin.** There is then nothing for
an escaped page to steal from another proxied site, because no proxied site ever
holds a passkey through STomp. An escaped page can still misuse the browser's raw
WebAuthn for the proxy origin, exactly as it can misuse that origin's cookies and
storage, but a credential it plants there is the proxy origin's own, bound to no
particular proxied site, which is the state the proxy origin is already in for an
escaped page.

The refusal is in `src/inject/dom/modules/Credentials.ts`, and it reaches no
authenticator:

- A relying party id the browser would accept (the document's own host, which is
  the proxy origin, or a registrable suffix of it) is the only id that reaches
  the browser's real authenticator. The inject hands the browser that id empty,
  the same mechanism the related-origins leak fix already uses for another site's
  id, read where and when the browser reads the page's (once, a `toString`
  included) so member read order and the synchronous `TypeError`s for malformed
  options are Chrome's. The browser refuses an empty id before consulting any
  authenticator, so nothing is ever made, asserted or planted. This is
  deterministic: no race, no reliance on aborting a request in flight.
- That refusal (a `SecurityError`) is reshaped into what the request ends as
  natively when no authenticator answers: `create()` and `get()` reject with
  Chrome's `NotAllowedError` ("The operation either timed out or was not
  allowed. ..."), and `PublicKeyCredential.signalUnknownCredential`,
  `signalAllAcceptedCredentials` and `signalCurrentUserDetails` resolve
  `undefined`, which is the no-op they are natively (they change nothing, since
  STomp holds nothing). A get with no relying party id (which defaults to the
  document's own domain, the shared origin) is refused the same way.
- An id of another site still ends as the related-origins refusal, and a
  malformed request still as Chrome's `TypeError`: these paths are unchanged.
- A page on an address proxy origin is refused by the browser itself (an address
  is no relying party), so nothing here runs for it.

The deliberate divergence from native Chrome is that a create or get which would
succeed natively (on a machine with a platform authenticator and a credential) is
refused. That is the price of safety on a shared origin, and the refusal is a
real browser state (a declined ceremony), measured against Chrome's own words.
The capability statics (`isUserVerifyingPlatformAuthenticatorAvailable`,
`isConditionalMediationAvailable`, `getClientCapabilities`) are left as the
browser's own: they create and assert nothing, so they are outside this boundary,
and a site that reads a platform authenticator as present and then meets a
declined ceremony sees a state a user who cancelled would also produce.

## The related origins leak

Independently of the above, a relying party id that is neither the document's
host nor a suffix of it makes Chrome fetch `https://<id>/.well-known/webauthn`
from its own process (WebAuthn's related origins, 5.11.1), with nothing of the
proxy in the way. On a domain proxy origin that let any proxied page make the
browser reach any host directly, and a site's own id reached the real site from
the user's address. The inject hands the browser an id it refuses without a
fetch and gives the refusal Chrome's words for a file that could not be fetched;
no such file lists the proxy. This landed earlier (the webauthn-related-origins
suite) and is unchanged here; the passkey refusal above reuses its machinery.

## What this is measured by

The passkeys-safety suite drives Chrome's virtual authenticator as the oracle:

- natively on a domain, a page makes a passkey the authenticator holds and
  asserts it (the hole is real), and a ceremony the authenticator does not answer
  is the `NotAllowedError` the refusals are compared against;
- through the demo on a domain (demo.localhost, every proxied page on one origin,
  as a `RemoteController`'s proxy origin is), a create and a get are refused with
  Chrome's words, the authenticator stays empty, a second proxied site gets no
  assertion, a signal is the no-op, a get with no relying party id is refused,
  and another site's id still ends as the related-origins refusal.

It needs no device, GPU or network and runs on the CI runner.
