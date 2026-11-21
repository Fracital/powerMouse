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

### Known limitations

- On Chrome 158 and later a frame a proxied page makes under the proxied
  top has `focus-without-user-activation` off, where natively it has it:
  the host frame's sandbox reaches every frame under it, and only each
  frame's own allow attribute could name the feature, which the page wrote
  without it. `focus()` before a user gesture does nothing in such a frame.
  `permissions-policy` and `surface-enumeration` list it as open for
  Chrome 158 and later.
