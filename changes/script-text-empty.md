### Fixes

- `script.text = ''` leaves the script without children, as natively: the
  hook appended an empty text node, so `script.firstChild` read a Text node
  where Chrome reads null. (wpt-script-element suite: script-text.html.)
