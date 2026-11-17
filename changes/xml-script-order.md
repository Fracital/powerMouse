### Fixes

- An XML document's external scripts run in the order it has them. An
  XHTML or SVG document is re-created through the hooks, where a script is
  no longer the parser's, and the browser ran each such script as it
  arrived: a small file ahead of the library before it (an XHTML page
  loading testharness.js and then its report script got "setup is not
  defined"). They keep their order now, as scripts that never asked for
  `async`. An inline script still runs before an external one ahead of it
  has loaded, which the parser would have waited for. (wpt-url-elements
  suite: the XHTML pages reported nothing before.)
