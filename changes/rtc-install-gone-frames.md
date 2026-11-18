### Performance

- A page's first WebRTC connection no longer stalls on the frames it has
  removed. The connection installs the WebRTC library for every document
  that shares its tables, and that included the window of every frame the
  page had removed that the collector had not taken yet, at ~20 ms each in
  the one task of the constructor: 4.1 s after 300 frames went through a
  ring of twelve, against 22 ms now (natively 2 ms), and 51 to 59 s in
  adversarial-sinks, whose page makes a connection after ~2500 frames and
  so ran past its suite's limit under CI's load ("0 probes, done=false").
  A window whose document has no view (its frame removed, or navigated to
  another origin) is skipped; it makes no connection and is handed no
  object. A page that churns ad frames and then makes a connection paid
  the same. (webrtc-lazy.)
