### Security

- A proxied document has a user activation only where it would natively: a
  click or key in a frame activates the frame, its ancestors and the frames
  of its origin, and nothing else. Every proxied document is of one real
  origin to the browser, so an input event activated every frame of the
  page, and in same-origin mode the host's own clicks and keys (the address
  bar, the toolbar) activated the page: a frame of another site, or an
  opaque one, read `navigator.userActivation` as active and could open a
  popup, enter fullscreen, lock the pointer, start a presentation, play
  sound, vibrate, copy, show a picker or the file picker, or navigate the
  top with `allow-top-navigation-by-user-activation` on a click it never
  had. Each document now notes the activations that are its own (an input
  event in it or in a frame that natively activates it) and those that only
  reached it through the proxy; at its first such activation, the
  gesture-gated calls of its realm answer as with no activation (Chrome's
  errors) while the browser's activation is explained only by it, and the
  browser's own activation stays a condition. A document that starts after a
  link of another site, or a URL typed in the address bar, has no sticky
  activation. (user-activation, against the same pages loaded natively.)
