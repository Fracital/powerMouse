### Performance

- A proxied document keeps fewer listeners on the browser's objects. Each
  module of a document's client listened on the service worker container
  for itself, so every message the worker sends a window (it tells every
  window of each change of the jar and of storage) was seven calls into
  the page's realm; one listener now hands each message to the modules in
  turn (apnews.com's top document made 457,000 of those calls in 40 s, now
  97,000). And the listener that keeps the browser's cookie change events
  (the synchronous bridge's answers are cookies of the proxy origin) from
  the page is added at the page's first read of `cookieStore`, the only way
  a page reaches the store: the browser tells a document of cookie changes
  only while its store has a listener, and every proxied document had one,
  so each answer of the bridge was an event in every frame (99,000 in the
  top document of apnews.com in 40 s, now 2,600). (inject-listeners suite.)
