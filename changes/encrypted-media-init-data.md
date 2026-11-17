### Origin isolation

- The encrypted event of another site's media loaded without CORS has an
  empty `initDataType` and an empty `initData`, as Chrome gives it natively.
  Every route is same-origin to the browser, so the page read the key ids of
  another site's encrypted media (directly, through a `<source>`, or through
  its own URL redirected to the other site). An event the page made keeps
  what it was made with. `encrypted-media` compares each case natively and
  proxied; `adversarial-encrypted-media` covers the escapes.
