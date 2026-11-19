### Performance

- Wisp over WebTransport takes two extensions holyWisp is building (the
  wire protocol: ~/.claude/stomp-work/wisp-lanes/SPEC.md). A relay that
  answers the protocol `wisp-v2-server-stream` opens the session's Wisp
  stream itself, with its INFO and CONTINUE in the flight of its 200, so
  the first Wisp packet is there when the session is ready, a round trip
  sooner (two for epoxy in v2). A relay whose INFO offers lanes (extension
  0xE1) takes several bidirectional streams per session: each Wisp stream
  rides the quietest lane for its whole life, so the session is no longer
  held to Chrome's one 6 MiB stream window a round trip, and a lost packet
  holds up only its lane's streams. Against a relay with neither, the
  session is the one stream it was. On the wire the session is now always
  Wisp v2: with epoxy in v1 the carrier says the INFO itself, at once, so
  the opening still takes one round trip. The carrier host's session has
  the lanes too: the streams of every transport riding it spread over
  them, and the controller's `carrier` says the session's `lanes` and
  `serverStream` to a rider as to the transport that opened it.
