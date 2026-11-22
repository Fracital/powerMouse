### Security

- A browser tab in Tor mode stays in Tor mode across its reloads even when
  another tab turned Tor off since: the saved choice is shared by the
  origin's tabs, and a Tor tab's reload came back up outside Tor. Only the
  tab's own toggle (or `?notor`) takes it out; turning Tor on in one tab
  still reaches the others at their next load. (demo-tor-fail-closed.)

### Demo and API

- Tor mode says why its bootstrap is stuck or failed: the client's status
  has `blocked: { kind, message }` from its own links to relays ("Cannot
  reach the Wisp server", "The Wisp server refuses links to Tor relays",
  "No Tor relay answered through the Wisp server (N links ended with ...)")
  and a failure's summary is that reason rather than arti's generic error,
  shown in the Tor toggle's tooltip, the status line and the error page. It
  reads arti's own bootstrap events (`bootstrapEvents`, arti's
  `bootstrap_events()`, with its blockers such as a skewed clock) where
  tor-js gives them; the tor-js side is not built yet. A link the client
  refuses (not a Tor relay) is told to the page, and a failed client is
  closed before the next request starts another. (demo-tor-fail-closed.)

### CI

- The `demo-tor-fail-closed` suite runs Tor mode's own client code with
  tor-js replaced by a stand-in it breaks on purpose
  (`STOMP_TOR_CLIENT=stand-in-arti`): bootstrap that never ends, every link
  failing at the Wisp server, circuits that do not build and a client
  dialing the site itself, in one tab, two tabs and across a reload, and
  checks the fixture page asked for is never reached, along with the
  reasons shown, the retry after a failure and a Tor tab's site data
  across its reload.
