### Fixes

- The demo's wisp server no longer locks a client out after a voice or video
  call. The holywisp 0.5.2 it bundled cost a client 15 points for each stream
  it refused to a private or loopback address, and a call's ICE candidates
  make many of those, so one Discord call put the demo's own address in the
  strict tier and every later connection was answered 403. holywisp 0.5.3,
  which the relays run, scores those streams at 0.
