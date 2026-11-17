### Fixes

- `history.pushState` to a fragment of the document's own URL
  (`pushState(null, '', '#part')`, what a smooth-scroll script does to
  change the address without a jump) fires no `popstate` and no
  `hashchange` and does not scroll, as natively. The entry is made at the
  link route first (the Visited module), and the module's own navigate
  listener took that step for a link's navigation to the fragment and made
  it one: the page got a `popstate` inside the call, a `hashchange` after
  it and the browser's scroll to the fragment. (wpt-history suite:
  history_pushstate_url.html.)
