### Fixes

- An `EventSource` the CORS protocol refuses is closed for good, as in
  Chrome (an `error` event with `readyState` CLOSED). The service worker
  answered the refusal as a network error, which an EventSource takes as a
  lost connection: the page saw `readyState` CONNECTING and the browser
  asked the other origin again every few seconds for as long as the page
  lived. (wpt-eventsource: the three cross-origin cases that must fail.)
