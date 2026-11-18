# The proxy's own origin as a site (proxy-ception)

A page of the proxy's own origin loads through STomp like any other site:
the demo, its examples and test pages, and a STomp of its own (the demo
loaded through itself) that then proxies a third site. The inner STomp is
page code to the outer one, contained like every other site: its requests
go out over the outer's transport, its storage is the emulated partition
of the proxy's origin, its service worker is an emulated one, and nothing
it names meets a name of the outer's. The proxyception suite loads the demo
through itself in both modes and checks each of these.

Until this, the service worker refused a route that decoded to the proxy's
own origin (403, "refused: the proxy does not proxy its own origin"), and an
option (`allowSelfProxy`, off in production) forwarded it instead. Neither
exists now. This page says what the refusal protected, what keeps each
property now, and what had to change for the inner STomp to work.

## What the refusal protected, and what keeps it

- **A loop: the proxy fetching itself.** A route of a route (a page that
  read its raw proxy URL through a path the rewriter missed and handed it
  back) is still not fetched: every routing hook unwraps a URL that is a
  route of this controller's codec, and the worker answers a navigation to
  one with a 307 to the single route (double-route suite). Anything else of
  the proxy's origin goes out over the transport, as every site does, so a
  page that frames the proxy's origin costs what a page that frames itself
  costs natively, one document per level the page asks for.
- **A way to the host's page and the worker.** What answers a request for
  the proxy's origin is the host's server as any client of the transport
  sees it (holyWisp's egress, in production through Cloudflare), never this
  worker, its controllers or the host's page. The worker's own endpoints
  (`/stomp/<id>/whoami`, the routes, the cookie jar) exist only inside the
  worker, so a page asking for them over the transport gets the server's 404. The document of a frame sent to `<proxy origin>/` is a proxied one,
  injected as any site's, whose `top`, `parent` and `opener` are the
  emulated ones; no page reaches a real window of the host. The page's
  cookies are the jar's for the proxy's origin, never the real ones, and
  its localStorage, IndexedDB, caches, BroadcastChannels and service worker
  registrations are the emulated partition of that origin, apart from the
  host's real storage both ways.
- **Blob URLs of the real origin.** A page sees its blob: URLs under its own
  origin and the proxy keeps them under the real one (routeURL.ts
  setBlobOrigins). For a page of the proxy's origin the two forms would be
  alike, and every blob: URL of the real origin (the host's, another
  site's private copies) would resolve for it. Its form differs in the UUID
  instead: each digit but the version's is flipped by a stream drawn from
  the codec's key (its own inverse), so a URL of the browser's form names a
  Blob that is not there, as another origin's does.
- **Names.** The inner STomp runs its bundles in the outer's realms, so any
  name the two share is a collision. The client's name was minted per
  controller already. The access API (`0..$s$j`, a non-configurable
  property of Number.prototype) and the two stand-in tags were fixed
  defaults: the inner's rewritten scripts called the outer's access API and
  the inner's hooks saw nothing. A controller whose host names none now
  mints them once per host origin and keeps them in its localStorage
  (src/controller/id.ts keptHelperNames), where an inner STomp keeps its
  own in its emulated storage. The marker attributes that keep a page's
  value of a routed attribute (`s_o:src`) take their prefix from the
  access name (helperNames.ts attributeMarker): with one prefix the inner's
  original of a frame's src was the outer's too, and the outer resolved the
  page's relative URL against the inner demo's origin. A dedicated worker's
  error-location message is keyed by the controller's `globalName`, which
  also keys every STomp message envelope.
- **The URL prefix.** Both STomps route under `/stomp/<id>/` of the proxy's
  origin. Under a keyed codec (xor, the default, and aes) the two stay
  apart by their keys: an inner route does not decode under the outer's
  key, so the outer never takes it for a route of its own and forwards it
  to the inner's emulated worker. A codec without a key (`plain`,
  `base64`) decodes every controller's routes alike, so there the routing
  hooks and the worker take a route of a route for their own only when it
  names their own controller id (routeURL.ts unwrapRoute's `own`), and
  leave another id's, and a link's route, which names none, to the STomp
  that made them.

## What had to change for the inner STomp to work

- **The sync bridge and large answers.** The inner's pages load the
  rewriter's wasm module (597 KB) with a synchronous request through the
  outer's bridge, whose answer travels in cookies; a host's jar keeps about
  180, so an answer of more chunks evicted its own first chunks. The
  worker now keeps a body too large for its cookies and the page reads it
  in parts (changes/sync-answers-in-parts.md), which covers this load.
- **The jar's turn.** A document's emulated `document.cookie` keeps what it
  read until something says the jar changed. A write of an emulated
  service worker (its Cookie Store API) was told to documents by a message,
  which a page spinning on the bridge never hears, and the inner's bridge
  answers are exactly such writes. The worker now sets a real cookie of
  the proxy origin (`sync-jar-turn`) to a new value after each emulated
  worker's write, and a document reads the jar again when it changed, as
  natively a cookie a service worker set is in `document.cookie` at once.
- **The site pool.** A navigation to a URL of a proxy origin is pinned to
  the hub only when it is a route of a route; any other URL of it is a
  site like another and is shown from a slot of its own.

## Production

stomp.fracit.al runs in same-origin mode with the pool off, its transport
the keyed holyWisp relay on its own host (`/config.js` names it, so every
visitor's page knows it). The inner STomp's transport is that same relay,
reached through the outer's WebSocket: wisp inside wisp, every byte through
holyWisp twice, egressing to stomp.fracit.al's Cloudflare address, which is
public. A local outer STomp over the public relay loads the production
demo through itself (the inner Ready in 6 s, its emulated worker
registered) and its inner proxies a third site. The relay refuses UDP to
stomp.fracit.al:443, so the inner's HTTP/3 to the proxy's own host falls
back to HTTP/2, as for any host the relay refuses UDP to. Nothing in the
deployment or holyWisp needs changing.

## Limits

- Under a codec without a key, a raw route another tab of the host leaked
  into a page (a rewriter miss) is no longer taken for a route of a route,
  since it names another controller id: it goes out as a URL of the
  proxy's origin, and the host's server answers it.
- With the site pool on, the inner demo reads the same `/config.js` and
  runs a pool of its own on the same slot ports: its routes land on its
  slots (another port of the proxy's host, not the hub's), whose agents
  are frames of those origins that the outer proxies like any site, each
  with the inner's emulated worker. The proxyception suite passes with
  `STOMP_SITE_POOL=6`.
- The inner's Server-Timing marks (`stomp-*`) on its emulated worker's
  answers reach the outer's inject as the outer's own: an emulated
  worker's answer is taken as the worker's already, unescaped. The outer
  then applies them to the page's timing entries, as the inner would have.
- Every level costs a full STomp: its bundles in each of its frames, its
  rewriter's wasm loaded through the bridge, and its transport tunnelled
  through the outer's.
