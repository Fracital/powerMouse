### Demo and API

- offline.html has vibeOS when its build has `dist/vibeos/`: the same
  switch, windows and `moveBefore` of each tab's frame as the served demo.
  The desktop, its icons, cursors, fonts and wallpapers and its three games
  are one gzipped archive in the file (about 4.4 MB of it; the file goes
  from about 10.8 MiB to 15.2 MiB), unread until the first switch, then made
  `blob:` URLs that vibeOS asks the page for by path (`vibeHost.assets`); a
  game's page carries its files as `data:` URLs. Only the files vibeOS's code
  and stylesheet name are in, and no emulator: it is fetched through the
  proxy and kept in Cache Storage, as on the served demo (docs/vibeos.md,
  "In offline.html"; `offline-vibeos`).
