### Demo and API

- `userAgent` on either controller gives every proxied document and worker one
  coherent Chrome identity: navigator, UA-CH, upstream HTTP and WebSockets use
  its full version and Linux or Android platform instead of the host browser's.
- The backend keeps current Linux and Android stable Chrome versions from
  Google's versionhistory feed, cached for an hour with last-good and fixed
  fallbacks. `/config.js` never waits for the feed; `STOMP_USER_AGENT` fixes an
  exact UA and `STOMP_LIVE_USER_AGENT=0` turns the feature off.
