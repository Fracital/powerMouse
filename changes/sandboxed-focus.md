### Fidelity

- A proxied page focuses an element without user activation on Chrome 158
  as natively. Chrome 158 turns `focus-without-user-activation` off in a
  sandboxed frame and every frame under it unless the frame's own allow
  attribute names it, whatever the sandbox's tokens, so the sandbox
  StompController and RemoteController put on a proxied frame (to keep the
  page from navigating the host) also stopped `focus()` before a user
  gesture in a frame whose host wrote no allow naming the feature. Each now
  names it in the allow of the frame it sandboxes, where the browser knows
  the feature and the host's attribute does not name it (`allowWithFocus`).
  A document's own policy still turns it off, through the service worker's
  Permissions-Policy. `wpt-script-timing` (031.html) covers it.
- A frame a proxied page makes or parses focuses without user activation
  on Chrome 158 as natively. The host frame's sandbox reaches every frame
  under it, so each such frame gets a real allow attribute that names
  `focus-without-user-activation`, decided as natively from the page's
  own allow (its first directive for the feature, `'none'`, `'self'`,
  `'src'`, an origin) and the page's sandbox on the frame, before the frame
  first navigates and again when the page changes its allow, sandbox,
  srcdoc or src. The page never sees it: `getAttribute`, the `allow`
  property, `attributes`, `hasAttributes`, markup, selectors, clones and
  mutation records read what the page wrote, or nothing. Where natively the
  frame does not have the feature the real allow does not grant it, and a
  document the service worker serves keeps its Permissions-Policy on top.
  `frame-focus` covers it, and `permissions-policy` and
  `surface-enumeration` no longer hold it open.

### Known limitations

- On Chrome 158 a `<frame>`, which has no allow attribute, has
  `focus-without-user-activation` off under the proxy, where natively it
  has it. A page's stylesheet selector on an iframe's `[allow]` matches
  the real attribute, as it does for any attribute the proxy rewrites.
