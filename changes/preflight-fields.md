### Fidelity

- A CORS preflight goes out as Chrome's network stack builds one: Accept,
  Access-Control-Request-Method and -Headers, Origin, User-Agent, then
  Sec-Fetch-Mode before Sec-Fetch-Site, and no Pragma or Cache-Control.
  STomp ordered it like a page's fetch and sent the `no-cache` fields of
  a cache-bypassing load, so every preflight (every cross-origin graphql
  or JSON POST) looked like no browser's. field-order compares one with
  native Chrome's.
