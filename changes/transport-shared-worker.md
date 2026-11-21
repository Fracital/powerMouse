### Transport

- A transport descriptor's `sharedWorker` names a SharedWorker script (an
  ES module) that the transports of every tab of the origin share: the
  controller starts it, since a dedicated transport worker cannot, and
  gives the transport a port to it as its first option's `sharedWorker`.
  Where none starts (no SharedWorker, as on Chrome for Android) the option
  is absent and the transport runs alone. `RemoteController` descriptors
  take it too. (transport-worker.)

### Demo and API

- One Tor client for all tabs: Tor mode's transport gives
  `demo/public/tor-client/shared.mjs`, a SharedWorker, its requests, so a
  second tab bootstraps nothing and every tab's circuits are one client's
  (isolated per site as in one tab), with one holder of the guard state.
  Where the SharedWorker does not start or answer in 15 s, the tab runs a
  client of its own as before. The client ends with the origin's last page.
