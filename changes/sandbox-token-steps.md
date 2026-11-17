### Fidelity

- A frame sandbox the page builds one token at a time keeps every token.
  Google's sign-in page makes its CheckConnection frame with
  `setAttribute('sandbox', '')` and then `sandbox.add` per flag; the step
  that wrote `allow-same-origin allow-scripts` wrote exactly the value the
  hook had made real of the step before, so the hook took the page's write
  for its own and put the earlier value back. The frame lost
  `allow-scripts`, its script never ran and the sign-in page never got the
  frame's `youtube:` message. A page's write of an attribute now always
  counts as the page's. (sandbox-tokens suite.)
