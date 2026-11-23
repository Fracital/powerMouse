### Fixes

- Dialing: a frame in a shadow root is dialed. Its call page's load is not
  composed, so it ended at the root and never reached the document's
  listener: the frame stayed on its call page and the page's load waited
  out the call's bound. Every shadow root now listens as the document does:
  one a script makes from `attachShadow` on, and one of the markup
  (declarative, open or closed) from the page's first read of it, or else
  from its call page's word that it is there (a composed event on its frame
  element, which the page never sees). Cloudflare Turnstile, whose
  challenge frame is in a closed root, passes under dialing as it does
  natively.
