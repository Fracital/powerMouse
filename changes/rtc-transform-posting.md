### Fixes

- An encoded frame a proxied page posts with a window's `postMessage`
  arrives in the window itself and in a document of its origin as
  Chrome's does, a document of another origin has a messageerror, and on
  a `BroadcastChannel` the message's data is null, as in Chrome (each
  arrived as an empty object). A frame written to a transform's writable
  is emptied, its metadata kept, as Chrome's is.
