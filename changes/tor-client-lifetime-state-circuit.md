### Demo and API

- Tor mode's shared client outlives a reload or a navigation of the
  origin's last page: its SharedWorker is started with `extendedLifetime`
  (Chrome 157), as the carrier host is, so the client keeps its circuits and
  its link to the guard and a reload bootstraps nothing. A new Tor session
  (the last Tor tab closed, a new one opened) gets the same client but none
  of the last session's circuits: its first page tells the client
  (`session` in the transport's options, `TorService.newSession`).
  Browsers without the option (Firefox, Safari) start the client again as
  before. (demo-tor-fail-closed.)
- Tor mode's menu has **Tor circuit for this site** (Tor Browser's "Circuit
  for this site"): the guard of the active tab's site's circuits (read from
  arti's guard state and the consensus the client keeps: nickname,
  fingerprint, address) and since when the site's circuit is used. tor-js
  tells nothing of a circuit's middle and exit relays and has no GeoIP, so
  those hops say so and no country is shown (docs/tor-over-wisp.md
  "Circuit display"). (demo-tor-fail-closed.)
- Tor mode's menu has **Forget Tor state**: the client's guards and
  directory (IndexedDB `stomp-tor-client`, kept across Tor sessions and New
  Identity, outside the `tor` profile) are deleted and the client starts
  again, sampling new guards; every Tor tab's connections start over. A
  start after a failed bootstrap now reuses the client's store wrapper, so
  its writes reach IndexedDB. (demo-tor-fail-closed, store-names.)
