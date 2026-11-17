### Fixes

- An event a page makes itself with another event's name no longer throws
  out of the inject. `window.dispatchEvent(new Event('message'))` reported
  an uncaught "TypeError: Illegal invocation" to the page's `onerror` (the
  inject's message listeners read `source` and `data` as a MessageEvent's),
  and in a dedicated worker `dispatchEvent(new Event('error'))` did the
  same from the listener that locates errors, so the worker's `onerror` ran
  once more, with the five arguments of that TypeError. (wpt-event-handlers
  suite.)
