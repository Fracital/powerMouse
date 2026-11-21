### Fidelity

- Shields in standard mode (the demo's default, as Brave's) no longer block
  a site's own requests: the lists judge third-party requests only, and the
  user's custom filters still judge every request, as in Brave. Aggressive
  mode blocks first-party requests as before. wisp.baby read 0 Mbps
  through the proxy on every visit after the first: its app imports its own
  `livestats.js`, which EasyPrivacy's generic `/livestats.js` rule blocked,
  so the app never ran and the page kept the 0 of its markup (the first
  visit passed only because the directory's snapshot, which serves until
  the lists are built, has no EasyPrivacy). The speedtest suite measures a
  speed test of that shape natively and through the proxy in both modes.
