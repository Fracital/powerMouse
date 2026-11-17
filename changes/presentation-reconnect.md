### Security

- `PresentationRequest.reconnect(id)` joins only a presentation this site's
  own documents were handed (by `start()`, `reconnect()` or a
  `connectionavailable` event); any other id is answered as the browser
  answers an id it does not know. The browser matches presentations by the
  real origin, which every proxied site shares
  (`src/inject/dom/modules/Storage.ts`). (presentation-reconnect compares
  what a page without a display sees; joining another site's presentation
  needs a display, which no test has.)
