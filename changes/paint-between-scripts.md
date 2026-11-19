### Performance

- A page whose body runs long scripts paints before the last of them, as
  natively: the network's parser yields to rendering once it has run a
  while. The page's markup is written in pieces, each script's from a
  microtask after the one before, so a script the cache had ready (it runs
  inside the write) held the paint until every script of the pass had run:
  YouTube back from another page ran its player for 700 ms inside one write
  and painted a second after the native page. Once the body has begun, a
  piece that ran 50 ms or more is now followed by a frame before the next
  (in the head there is nothing to paint, and a frame there was a style
  pass over CNN's 3 MB of head CSS for nothing). YouTube watch, Chrome 157
  headless, medians of six with the storage and markup script changes: first
  paint on back 1437 to 813 ms (natively 833; it was bimodal, 762 to 2006),
  reload 994 to 788 (783), link 826 to 791 (873). (paint-between-scripts
  suite: three 150 ms scripts after the first heading, the first paint
  comes before the last one ends, as natively.)
