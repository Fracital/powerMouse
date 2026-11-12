# Chrome's process model, measured for proxying

Every proxied site shares the proxy's one origin, so Chrome puts the frames
of different sites in one renderer process (CHANGELOG known limitations):
a busy loop in a parent holds up its frame's timers, the frames read one
heap, and a message round trip takes 0.03 to 0.2 ms instead of 1 to 2.
Cloudflare Turnstile notices. This page records what plain Chrome does
(152 and 156 alike, no proxy, a fixture answering many host names on one
port), as the reference for emulating separate origins in one.

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
