### Performance

- The service worker builds fewer Headers and Responses for each proxied
  request. A response that both the HTTP cache and the memory cache keep
  has its body split once for the two stores and the page, where the
  memory cache split the page's copy again, wrapped in a Response of its
  own (`splitForStores` in `src/server/cache.ts`). The transport's answer
  is a Response made from the transport's list of fields, with no Headers
  in between (`transportFetch` in `src/server/rewrites.ts`). A request with
  no validator to add goes out with its own fields, not a copy of them. The
  HTTP cache's writes and hits, the memory cache's entries and hits and the
  rewrite cache's kept scripts edit the fields of the Response they make,
  where each made a Headers first. A constructor is handed a Headers'
  entries as an array (`src/server/fieldList.ts`): handed the Headers, it
  reads it through the iterator protocol at about twice the cost (22
  against 11 us for 14 fields). A local page of 200 subresources (80
  scripts, 60 stylesheets, 60 images, CDN headers, half of them immutable),
  18 cold loads each in 12 alternated rounds, load average 17 to 25:
  the worker's script time went from 244 to 220 ms (median), the self time
  of the Headers and Response constructors from 26.3 to 14.1 ms, and the
  body split's from 15.7 to 1.1 ms (Chrome 159). Header filtering, cookies,
  caching and streaming are unchanged.
