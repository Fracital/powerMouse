### Transport

- A reload and a second tab of the same host ride the wisp connection that
  is up already. The transport's carrier (the WebTransport session, or the
  WebSocket) lives in the carrier host, a SharedWorker of the transport
  worker's script that Chrome keeps for five minutes after the origin's
  last page (`extendedLifetime`), and every transport of the origin rides
  it as a wisp connection of its own, its stream ids mapped onto the
  relay's. Before, each reload and each tab opened a session again (about
  350 ms warm to holyWisp at 34 ms). A start rides the host's carrier
  where it would have ended on it anyway (a session, the WebSocket with
  WebTransport off, or the WebSocket a failed session left while its 30 s
  last), and chooses again otherwise. The controller's `carrier` has
  `shared` (how long the carrier had been up, in ms) when it was the
  host's, and the console says `riding the WebTransport session to <url>
that is up already`. `ControllerInit.carrierHost: false` turns it off.
  `carrier-host` covers reloads, tabs, Wisp v2, a tab that closes, a relay
  restart and the host ending under its pages.
