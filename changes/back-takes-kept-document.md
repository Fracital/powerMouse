### Performance

- Back and Forward to a document show it from the HTTP cache, as natively,
  whatever cookies the page set since. Chrome asks its cache to take any
  entry it has for a history step, and the worker's rule for an entry made
  with other credentials (confirm it with the origin, or fetch it again
  when it has no validator) sent the step to the network instead: CNN,
  whose scripts set cookies on every visit, was fetched and rewritten again
  on every Back after the first (proxied responseStart 52 to 112 ms vs 27
  from the cache). The rule stays for every other request (http-cache
  suite, history rows).
