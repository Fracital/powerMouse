### Performance

- A document with a large inline style gets its head's record to the page
  in less time: the table that goes with the markup carries such a style's
  rewrite as the rules it changed, plus where the other rules stand in the
  style. The whole rewrite took 42% of CNN's head record: 2.8 MB more for
  the service worker to stringify and encode, and for the page to receive
  and parse. CNN's 2.78 MB style now packs to 237 KB. The worker sends a
  rewrite whole when it is small, when most of it changed, or when the
  pieces would not give it back byte for byte. (rewriter-unit: a packed
  style comes back byte for byte; html-stream: a 1.5 MB head style applies
  as natively.)
