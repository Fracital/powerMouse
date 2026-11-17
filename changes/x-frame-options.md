### Fidelity

- A frame whose document sends `X-Frame-Options: DENY` or `SAMEORIGIN` is
  refused through STomp as it is natively, against the frame's real
  ancestors' origins: the header was stripped and nothing stood in for it,
  so any site could be framed by any other. A `frame-ancestors` policy
  still overrides it, a list of several values refuses as Chrome's does,
  and a frame whose document is no HTML (an image, a PDF) is judged too.
  (x-frame-options, adversarial-headers suites.)
