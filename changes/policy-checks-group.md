### Performance

- A frame under a script policy of the page's (nonces, 'strict-dynamic')
  evaluates only the policy checks' code, not the long animation frames',
  the position maps' and the integrity checks' with it: about 2 to 3 KB
  less heap a frame (Chrome 157). frame-cost now gates such a frame.
