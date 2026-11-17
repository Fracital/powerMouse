### Fixes

- `location.protocol = value` throws the browser's SyntaxError
  (`'x!' is an invalid protocol.`) for a value that is no scheme, as
  natively, where the proxy's URL setter left the URL as it was and the
  page reloaded itself (web-platform-tests' `location-protocol-setter.html`
  timed out in that reload). Chrome takes the value up to its first colon as written, so a
  tab or a line break in it throws too (measured, Chrome 152).
  (wpt-location suite.)
