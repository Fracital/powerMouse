### Fixes

- A reload of the host page (Ctrl+Shift+R most often) brings the proxied
  page back at once, where it often showed nothing for 10 s or more. The
  host's pagehide tells the service worker its controller is going, and
  Chrome runs it before its frames' own, so a storage read or cookie read
  a proxied page made in its pagehide (Twitch, YouTube) reached the worker
  after the close, found no controller and went to the host's server: the
  page spun to the synchronous bridge's 10 s limit on the renderer the
  reloaded host page needed to commit, and the writes it made as it left
  were lost. The worker now keeps a closed controller's address answered
  for its documents' requests for 15 s (its transport is closed, so what
  needs the network fails at once). On stomp.fracit.al with Twitch, 5 hard
  reloads in 6 waited about 10 s before; locally with the host cross-origin
  isolated, 3 to 4 in 8 did and none in 10 after (hard-reload).

### Demo and API

- A proxied page at the top of a tab of its own (a popup, a link opened in
  a new tab) comes back from Ctrl+Shift+R, which Chrome sends past the
  service worker: the demo server answered the page's address with its
  "Cannot GET" error, and now answers a forced reload of it with a page
  that reloads once more, plainly, through the worker.
