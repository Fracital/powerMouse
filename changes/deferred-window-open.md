### Build

- What window.open() does with its URL and target (this window, the
  proxied parent or top, a window of another slot, a frame or popup of the
  tab by that name, a new tab the host opens) and the tab's note of the
  window it opened are a deferred part of the document bundle
  (`src/inject/dom/windowOpen.ts`), made in the call, before the browser
  is asked, so the call stays inside the user's activation;
  `document.open()` with three arguments reaches it too. Without the part
  the call throws and nothing opens (deferred-refusals).
