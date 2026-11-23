### Performance

- The service worker spends less of its thread on a page's load: a script
  never rewritten before is a miss by the rewrite cache's own index (read
  once) instead of a CacheStorage lookup; the HTTP cache's writes of whole
  bodies wait until the worker has nothing more urgent, 2 s at the most (a
  request for the URL, a clear and Clear-Site-Data start them at once); and
  a response body of 64 KB or less that the transport has whole crosses
  with its headers in one message instead of on a port of its own. A page
  of 200 subresources loaded in 204 ms instead of 260 in the bench, the
  worker's CPU 191 ms instead of 217.
