### Fixes

- A site whose script wrote a cookie with a character a byte cannot hold
  (`Zürich☃`) no longer fails every request after it: the Cookie header
  carried the text as it was, which Headers refuses, so the tab showed the
  error page the next time the page loaded (CNN did a few minutes in). Such
  a cookie goes as its UTF-8 bytes now (cookie-bytes).
