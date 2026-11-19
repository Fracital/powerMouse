### Performance

- A proxied top takes the rewriter's compiled core module from the window
  the controller runs in (the host's page in same-origin mode, the
  controller's frame beside it in isolated mode) when its client is made,
  instead of asking for it through the service worker. The answer to that
  message came a median 280 to 440 ms after the navigation started on real
  sites, and about half the top loads rewrote something before it (an
  inline script's eval, a `javascript:` link the shell routes, a style),
  each fetching core.wasm with a synchronous request and compiling it on
  the page's main thread (Wikipedia, MDN, Stack Overflow, Google, CNN):
  their first rewrite took a median 10 to 12 ms, and takes 0.5 to 0.7 ms
  now. The workers a top starts are handed the module at once too. Only a
  window that reaches no window of the controller's (opened with
  noopener) still asks for the bytes (cold-start, core-module-cache).
