### Fixes

- `fetch(request, init)` applies the init. The fetch hook read a `Request` it
  was given and dropped the second argument but for its mode, so the method,
  body, headers, credentials or signal the init named never reached the
  request (`fetch(request, { method: 'PUT', body })` went out as the
  request's own POST; `{ signal: null }` kept the request's signal). It is
  now a fetch of `new Request(request, init)`, as the browser's is.
  (wpt-fetch-abort suite.)
