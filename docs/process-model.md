# Chrome's process model, measured for proxying

Every proxied site shares the proxy's one origin, so Chrome puts the frames
of different sites in one renderer process (CHANGELOG known limitations):
a busy loop in a parent holds up its frame's timers, the frames read one
heap, and a message round trip takes 0.03 to 0.2 ms instead of 1 to 2.
Cloudflare Turnstile notices. This page records what plain Chrome does
(152 and 156 alike, no proxy, a fixture answering many host names on one
port), as the reference for emulating separate origins in one. What each
frame costs that shared renderer in memory is docs/frame-memory.md.

## Which frames get a process of their own

The probe: the parent spins 300 ms while its frame measures its own
timers; a frame in the parent's process sees a 300 ms gap.

| frames                                                                                                                               | process               | frame's timer gap              |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------ |
| `localhost` and `x.localhost` (no registry: the host is the site)                                                                    | separate              | 6 to 11 ms                     |
| `x.localhost` and `y.localhost`                                                                                                      | separate              | 6 to 11 ms                     |
| `a.zone.localhost` and `b.zone.localhost` (one site, `zone.localhost`)                                                               | shared                | 301 ms                         |
| the same with `Origin-Agent-Cluster: ?1` on the frames                                                                               | separate              | 6 to 8 ms                      |
| `a.stomp.example.com` and `b.stomp.example.com` under `stomp.example.com`, secure context, without / with `Origin-Agent-Cluster: ?1` | shared / separate     | 301 / 4 to 10 ms               |
| the same over plain http (not a secure context: the header is ignored)                                                               | shared                | 301 ms                         |
| a popup and its opener, same-site origins, the header on both                                                                        | separate, opener kept | 7 ms                           |
| native, without site isolation (`--disable-site-isolation-trials`)                                                                   | shared                | (Turnstile shows its checkbox) |

So one origin is always one process for its frames, a site is one process
unless a secure document asks for an origin-keyed agent cluster, and two
sites are two processes. Giving every proxied site an origin of its own
(a label under a wildcard zone, each document sending
`Origin-Agent-Cluster: ?1`) splits them as natively; it was prototyped
(a hub controller embedding an agent frame per site origin, a worker per
origin, cross-site navigations as 307s between origins) and works, but it
needs wildcard DNS and a certificate for the zone, which the deployment
does not take on. It is not pursued.

## Ports of one host

The split that needs no name: an origin is scheme, host and port, and a
port needs no DNS record and no certificate of its own. Measured
2026-11-15 with a fixture answering on eight ports of `localhost` (http, a
secure context) and of `https://stomp.example.com` (a resolver rule and a
certificate Chrome was told to accept), fresh profile for every run, three
runs a case; process ids are the browser's own (chrome://process-internals,
CDP `SystemInfo.getProcessInfo`, the `iframe` targets). The two shapes and
Chrome 152 and 156 gave the same answer in every row; the times are under a
machine load of 30 to 65.

| documents (P1, P2, P3: ports of one host)                                                           | process                                                                                      | frame's timer gap                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| top P1, frame P2, no header                                                                         | shared (keyed by site)                                                                       | 301 to 302 ms                       |
| the same, `Origin-Agent-Cluster: ?1` on the frame only                                              | separate (the frame's is keyed by its origin)                                                | 6 to 7 ms                           |
| on the top only                                                                                     | separate (the top's is keyed by its origin, the frame is in the site's)                      | 7 to 8 ms                           |
| on both                                                                                             | separate                                                                                     | 7 to 22 ms                          |
| a popup with its opener, P1 to P2, the header on both / on neither                                  | separate, opener kept / shared                                                               | 7 to 8 / 301 to 302 ms              |
| top P1 with frames P2, P3, P2 > P3 > P2 and P2 > P1, the header on all                              | one process a port (3 for the 8 documents); a document joins its port's process at any depth | 6 to 14 ms; 301 to 304 for P1's own |
| the same without the header                                                                         | one process for all 8                                                                        | 301 to 304 ms                       |
| a frame that goes from P2 to P3 (its `src`, its `location`, set from outside, a 307), the header on | moves to P3's process; the page's `frames[0]` and `contentWindow` are the same object after  | 7 to 22 ms after                    |
| P2's first document in the tab without the header, later ones with it                               | all keyed by site (in a frame, after it is removed, navigated, in a popup of the tab)        | 301 ms with the site's others       |
| P2's first document with the header, later ones without                                             | all keyed by origin                                                                          |                                     |

So a port splits exactly as a host name does: not by itself, and with the
header on its documents, from a secure context. The first document an
origin shows in a browsing context group decides the keying for every
later one there (a new tab decides again), so the header has to be on
every document of such an origin, the first one above all.

- A document of a port reaches the documents of its own port
  synchronously wherever they are in the tree, and no other: a frame of
  another port reads as a frame of another site does in every WindowProxy,
  Location, message and structured clone row measured (the allowed
  cross-origin members alone, `SecurityError` on the rest, `messageerror`
  for a `WebAssembly.Module`, `event.origin` with the port), and a `fetch`
  to another port is a CORS request (`TypeError` without
  `Access-Control-Allow-Origin`, `opaque` under `no-cors`). What differs
  from another site: `document.domain` reads the host, the same on every
  port, and two documents of two ports that both set it reach each other
  only when both were served with `Origin-Agent-Cluster: ?0`; the server
  sees `Sec-Fetch-Site: same-site`; and cookies ignore the port, so every
  port's requests carry the host's cookies (`SameSite=Lax` and `Strict`
  ones too) and `document.cookie` is one for all ports.
- Nothing is partitioned between ports of one host: a frame of P2 under a
  top of P1 has P2's own localStorage, IndexedDB, Cache Storage, origin
  private file system, BroadcastChannel, shared workers, Web Locks and
  service worker registrations, as a tab of P2 does (under a top of
  another site each is partitioned). A frame of one fixed port sees one
  store from under every other port's documents.
- A service worker registration is one origin's: each port needs its own
  (P1's is not listed on P2 and its worker sees none of P2's requests;
  registering across ports is a SecurityError), all may name the same
  script path, and the script is fetched once for each port. A worker of
  P2 controls a frame of P2 under a top of P1, its navigation and its
  subresources. The worker threads do not run in their port's process:
  the workers of every port of a host share processes keyed by the site
  (with any document of the host served without the header), whatever
  header their script carries.
- What a port costs (the https shape, Chrome 152 / 156, medians): a
  process of its own is 8.0 / 9.7 MB of renderer Pss for a tiny document,
  and five ports with a worker of STomp's size each (407 KB of script, a
  stand-in of that size) take 81 / 85 MB more than one origin with five
  frames and one worker. Such a worker is active 147 / 143 ms after a
  hidden frame of a fresh port starts to load (222 / 215 ms in a tab of
  its own), and five ports registered at once are all active after 304 /
  336 ms. A frame's first script runs 24 / 22 ms after its `src` is set
  when its port's worker runs, 70 / 64 ms when the worker was stopped, 45
  / 49 ms on a port without a worker, 12 / 14 ms for a frame of the top's
  own origin. A message to a frame of another port and back takes 0.3 ms
  (0.1 ms on a MessageChannel), the same as to another site, and under
  0.1 ms within one process.

## Other native facts

- Sec-Fetch-Site between `a.zone.localhost` and `b.zone.localhost` is
  `same-site`; between `x.localhost` and `y.localhost`, `cross-site`.
- A cookie with `Domain=zone.localhost` set by `a.zone.localhost` reaches
  every name under the zone; `Domain=localhost` is refused.
- Every `*.localhost` is a secure context and registers a service worker,
  top-level and framed. `--unsafely-treat-insecure-origin-as-secure` takes
  a host wildcard only (`*.stomp.example.com`), not the apex, and no
  scheme.
- A frame of one site under a top of another is storage-partitioned apart
  from the same origin top-level; a tab and a popup always share.
- A service worker's 307 for a navigation (Response.redirect or a
  hand-made one) is followed in the same browsing context for a frame's
  `src`, a link, a form POST, `window.open` and `location.href`: one
  history entry, `back()` returns, the frame's window and a popup's
  `opener` keep their identity, the POST body arrives (302 and 303 make it
  a GET), and the next origin sees the initiating document's Referer,
  narrowed to its origin by the default policy, and `Origin: null`.
- What a separate process costs: 11 to 13 MB Pss each (ten tiny frames of
  ten sites, 86 to 90 MB more than the same frames of one origin); a
  service worker of STomp's size installs on a fresh origin in 225 ms (156)
  to 321 ms (152) from navigation to activation.
- Chrome's URL parser takes any DNS label (64 characters, a leading
  hyphen, `ab--cd`, an invalid `xn--`), but a 64-character label never
  resolves.
