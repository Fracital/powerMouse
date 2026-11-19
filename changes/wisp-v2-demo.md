### Performance

- The demo runs epoxy in Wisp v2 (`wisp_v2`), so a relay that offers
  stream credit holds back a body read slowly on its own stream alone. It
  costs no round trip where the relay sends the CONTINUE for stream 0 with
  its INFO: holyWisp over a WebTransport session whose Wisp stream it
  opens, and over a WebSocket from 0.5.4+78095bf on. Against the edge, v2
  reached a first response in 282 ms against v1's 277 over the WebSocket
  and 277.5 against 272 over a session (about 17 ms away, within the
  noise); at 100 ms RTT, where the CONTINUE waits for the client's INFO,
  v2 took 413 ms against 313.
