### Fixes

- A page that sets another proxied window's location to a fragment of
  that window's document (`frame.contentWindow.location = '#x'`) navigates
  it synchronously, as natively: its URL has the fragment when the setter
  returns. It was navigated a moment later, as a navigation to another
  document is, so a javascript: URL's document queued just before it had
  the URL without the fragment. (wpt-location.)
