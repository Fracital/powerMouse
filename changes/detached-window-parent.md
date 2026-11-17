### Fixes

- `parent` read through another window's stand-in (a frame's window as
  its parent reads it) is `null` once that window's frame was removed, as
  natively and as the window's own `parent` already read, where the
  stand-in answered with a window (the page's top as that window saw it).
  (wpt-windows suite.)
