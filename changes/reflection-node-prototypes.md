### Performance

- A page's `Object.getOwnPropertyDescriptor` and the other reflection the
  inject hooks are about as fast on an interface's prototype as on any other
  object. Each one asked of `HTMLDivElement.prototype` or
  `Element.prototype` cost 2.1 to 2.5 us, where natively it costs 0.05.
  The hook read the prototype's `nodeType` to tell a document of another
  window, and every node interface's prototype threw on that read. The
  check now asks the browser's own getters, so no page code runs. It
  remembers each object the browser refused, since that answer never
  changes. Such a call now takes 0.13 to 0.16 us on Chrome 157.
- A frame whose window its parent read before the frame loaded (as an ad
  script does with a frame it makes) takes 4.1 ms less to start (median of
  60 frames, Chrome 157): 7.9 ms where it took 12.0. Its own bundle's
  evaluation went through those hooks, and took 1.4 ms instead of 5.4.
