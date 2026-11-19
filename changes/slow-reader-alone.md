### Fixes

- A tab whose body readers are slow no longer holds back every other tab
  of the profile: the carrier host stopped reading the relay connection,
  which carries all of them, until the slow tab caught up, so a second
  tab's download ran at the slow reader's pace and WebRTC's datagrams
  waited with it (webrtc-media's calls timed out in ICE checking on CI).
  The host now holds the relay back for a slow tab 50 ms at most, never
  while a UDP stream is open or another tab's readers keep up, and queues
  the slow tab's packets past that. A queue past 64 MB holds the relay
  back again while its readers still take some, and once they took
  nothing for 2 s the stream that holds most of it is reset. Within a tab a datagram goes past the bytes that
  wait for body readers. With a 48 MB body read at 3 MB/s in one tab, a
  128 MB download in another took 4.6 s with no wait past 85 ms, where it
  took 13.3 s with one wait of 8.9 s (carrier-slow-reader).
