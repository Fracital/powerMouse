### Performance

- The service worker's copy of the cookie jar forgets only the domain a
  write was of, not every domain: on an ad-heavy page, whose ad networks
  set cookies all the time, most of the jar reads of every request went to
  IndexedDB.
