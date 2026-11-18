### Fidelity

- A cookie a page's `fetch()` or XMLHttpRequest response sets reaches
  every other document of the site before the page sees the response, as
  natively: a popup that fetched a `Set-Cookie` and then posted to its
  opener sometimes had the opener's `document.cookie` read without it. The
  service worker tells documents of a change by a message of its own,
  which the page's message could overtake. Its answer now names the hosts
  whose cookies it stored (a `stomp-jar` Server-Timing mark the page never
  sees, carried along a redirect chain), and the inject that hands the
  page the response first stamps those sites' cookie versions, so every
  other document of the site reads the jar again. Under load the opener
  read a stale value in 12 of 15 runs of twelve reads before and in none
  of 15 after, and WPT's `cookies/samesite/fetch.https.html` failed 1 of 20
  runs before and none of 20 after. A navigation's or a subresource's
  `Set-Cookie` still reaches other documents by the worker's message
  alone. (popup-cookie-reads, wpt-cookies-more suites.)
