### Fixes

- `element.getAttributeNS(null, name)` (or `''`) reads the attribute of no
  namespace whose local name is exactly `name`, as natively. It answered
  `getAttribute(name)`, which lowercases the name on an HTML element and
  finds the first attribute of any namespace by its qualified name, so
  `getAttributeNS('', 'FOO')` read the `foo` that `setAttribute('FOO')`
  wrote, and an attribute of another namespace named `x` answered for the
  one of none. The value of an attribute a hook rewrote or dropped is still
  the page's. (wpt-dom-insertion suite: attributes, Element-setAttribute,
  Element-removeAttribute.)
- `win.location.href = url` and `win.location = url` on a window of another
  proxied origin (a cross-site frame, a popup) make a history entry in that
  window, as natively, where the proxy replaced its current entry: Back in
  it then skipped the page it had shown, and the new document's
  `navigation.activation.navigationType` read `replace` where Chrome reads
  `push`. A window still loading its document is replaced, as natively.
  (wpt-location suite.)
