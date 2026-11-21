### Fixes

- A listener a host's hook adds while it runs is the host's, not the
  page's: since the demo's load hook listened for `navigate` in every
  proxied top, the Visited module took every page for one that listens, so
  no link was routed through its link route (nothing read `:visited`,
  `visited`), and a navigation's redirects through another origin showed
  as two in its navigation timing where Chrome shows none
  (`performance-navigation`). The count of a realm's listeners
  (src/inject/uploadListeners.ts) skips a call made while a hook runs.
