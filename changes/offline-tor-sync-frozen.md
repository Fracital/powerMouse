### Fixes

- offline.html's Tor mode loads a real site again, in Firefox and in
  Chrome: a site whose markup came in pieces (Google, Wikipedia) left the
  tab on Loading for good with a blank page. The page's worker is told no
  synchronous request can be answered there through the store it reads at
  start, and the file wrote that only into the normal profile's store, not
  Tor mode's (`stompConfig|tor`): Tor mode's documents read their stores
  through the bridge, and a streamed one's first read of its localStorage
  resolved its route against about:srcdoc and failed the markup. Firefox
  keeps one localStorage for every file: page, so Tor mode turned on in an
  earlier copy of the file is on in the next one. npm run
  test:firefox now types a real https site into the build's own file,
  without Tor and in Tor mode on the real Tor network (SKIP_NETWORK=1
  leaves both out).
