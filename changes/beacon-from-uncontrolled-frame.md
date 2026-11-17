### Fixes

- `navigator.sendBeacon` from a frame the page built reaches the site. A
  document no service worker controls (an about:blank frame a page creates
  for its tags or its ads, a document it writes into one) sent its beacon
  to the routed address, and Chrome hands such a document's requests to no
  worker: the beacon went to the proxy origin's own server, which answered
  404, and the site never heard, while `sendBeacon` said true. It now goes
  out as a request of the nearest controlled document, as that document's
  fetches already do: a POST with the beacon's body, its Content-Type, its
  mode (no-cors, or cors with a preflight for a Blob of another type) and
  credentials, without a Referer as Chrome sends none for about:blank, and
  counted against the frame's own 64 KiB of beacons in flight, past which
  `sendBeacon` answers false as natively. A popup the page opened on
  about:blank has no such document above it and is as it was.
  (wpt-beacon: all 32 listed failures, the payload kinds and sizes, the
  quota, redirects and CORS from a frame.)
