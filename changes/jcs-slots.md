### Demo and API

- Content slots for dialing (just call stomp): with `sitePool: { origins }`
  a dialed tab's documents are written into the call page of their site's
  slot, another port of the host with `Origin-Agent-Cluster: ?1`, so the
  host page (powerMouse's UI) and the pages are two agent clusters and two
  processes that reach each other by messages only, and each slot is a
  process of its own. A call is made from the origin its navigation would
  begin on (its referrer's, else the site's slot); a worker whose site is
  another slot's answers that the document moved (`x-stomp-call-moved`, in
  place of the 307 a navigation gets) after it handed that slot's worker
  what it knew, and the host, or the called document for its own frames,
  calls again from a call page there. A frame of the page's own site stays
  on its parent's slot, a frame of another site goes to its own. Where no
  slot is configured, or the site's slot does not answer (a network that
  lets the host's port through alone, a slot whose agent went), the
  document is written on the host's own origin, as before. A slot's call
  page is the same asset as the host's (`assets.callPage`, under the same
  directory), its worker serves it only for the agent's controller, which
  takes the hub's `dialing`, and each call's one-time token is held by the
  worker of the origin the call is made from: the hub mints it and hands it
  over the slot's agent, and a moved call gets a fresh one there. A slot
  whose agent gives no token, or whose call page does not say it is ready
  within 10 s, is left out and the document is written on the host's
  origin; Back to a document of a slot restores its scroll, which the
  document reports over its port. The new
  `sitePool.warm: false` starts a slot's agent and service worker only
  when the first site is shown from it; the demo uses it for the content
  slots. The demo server answers on `STOMP_SLOT_PORTS` (a list or a number
  of free ports; behind a front `STOMP_SLOT_PORTS_PUBLIC`, production's
  four Cloudflare ports 2053, 2083, 2087, 2096), off by default, and only
  the page in dialing mode (`?mode=just-call-stomp`) uses them. A page
  spinning 200 ms of every 250 in a tab held the host's key input to 148
  ms (p95) in one origin and 1 to 2 ms from a slot. The ports are not a
  cookie boundary and not a sandbox (docs/content-slots.md); the
  jcs-slots suite checks the process split, storage, reach, the lazy
  registration and the fallbacks against Chrome on four ports.
