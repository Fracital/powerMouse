### Fixes

- The HTTP cache walks its store once at a time. Past its 50 MB budget every
  write started a walk of its own (every entry listed, each one's headers
  read) and waited for it, so a page full of cacheable loads started one per
  load, hundreds at once, each holding a Request and a Response for every
  entry: a browse of 30 sites grew the service worker to 1.4 million
  Requests and 1.3 GB in four minutes, and a resource the cache had just
  kept took 22 seconds to load again. One walk runs at a time now, after the
  write is done. (cache-walks suite.)
