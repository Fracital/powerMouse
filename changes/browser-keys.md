### Demo and API

- The demo takes Chrome's tab keys as its own: Ctrl+R and F5 reload the
  tab, Ctrl+Shift+R, Shift+F5 and Ctrl+F5 reload it past the caches,
  Ctrl+T opens the new tab page with its address bar focused,
  Ctrl+Shift+T reopens the tabs closed (the last one first, each where
  it was, the newest 25 kept) and Ctrl+W closes the tab; a Mac's are
  Cmd's. The demo's own page is never reloaded, from its address bar or
  from inside a proxied page, in a text field too. In a proxied page a
  reload key reaches the page first, and a page that cancels it keeps
  it, as in Chrome 157 (measured), reading `defaultPrevented` as its own
  calls left it. Chrome 157 never gives a page Ctrl+T, Ctrl+Shift+T,
  Ctrl+N or Ctrl+W in a tab, so there they stay Chrome's (the demo does
  not pretend to cancel them); in fullscreen it does, and the demo also
  asks for them with the Keyboard Lock API, and in the installed app's
  window, where Chrome reserves no shortcut, they are powerMouse's too
  (pwa suite). Shift or Ctrl with a click on Reload is a hard reload, as on
  Chrome's button (demo-keys suite).
- `frame.reload({ bypassCache: true })` is Chrome's hard reload
  (LOAD_BYPASS_CACHE), on both controllers and with the site pool: the
  document, its frames and what each loads until its load event is over
  go past the HTTP cache and the memory cache with `Cache-Control:
no-cache` and `Pragma: no-cache`, as `Page.reload` with `ignoreCache`
  does natively; nothing kept is cleared. A request after the load event
  takes the caches again (demo-keys suite).
- A host hook's `stomp.holdDefault(event, then)` cancels the browser's
  action of an event at once and calls `then` after the page had the
  event, unless the page cancelled it.

### Fidelity

- A host page's hard reload ends for the page it restores at that page's
  load event, as natively, not 30 s later, and the frames the page makes
  while it loads are fetched past the caches too.
