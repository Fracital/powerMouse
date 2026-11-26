### Performance

- A page whose resource timing buffer is full no longer costs the proxy a
  URL parse per buffered entry for each entry it loads. Once a page's 250
  entries are in and it never calls `clearResourceTimings`, the browser
  fires `resourcetimingbufferfull` for each later load. ResourceBuffer then
  counts the whole buffer again, which asked for the page's URL of every
  entry and parsed every routed name each time. krunk.io's game holds 272
  entries and saw about 14 such events a second as a match started; each
  count took 2.1 ms in Chrome 159. The page's URL for an entry is now kept
  with the entry (its name never changes), and a count takes 0.24 ms. In
  8 s of play the observer went from 109 to 143 ms to 12 to 16 ms, and the
  inject's whole share of the main thread from 381 to 440 ms to 234 to
  373 ms.
