### Performance

- A localStorage or sessionStorage write while no document of another realm
  holds a copy of the store no longer waits for the service worker: it goes
  as a beacon with the operation in its URL, which Chrome sends even when
  the page unloads in the same task, and the worker applies a realm's
  writes in the order made. The documents of one bundle (a page and its
  about:blank frames) now write a store in one sequence.
