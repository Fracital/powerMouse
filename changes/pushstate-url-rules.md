### Fixes

- `history.pushState(state, '', '')` and `replaceState` with the empty
  string keep the entry's URL, fragment included, as natively: the proxy
  resolved `''` like any other URL, against the base URL, so the fragment
  was dropped, and a page with a `<base href>` was moved to its base URL.
  A URL that names other credentials than the document's
  (`http://user:pass@host/`) is refused with the SecurityError Chrome
  throws; it was accepted. (wpt-history suite.)
