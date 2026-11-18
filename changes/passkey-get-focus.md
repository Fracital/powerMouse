### Fidelity

- A page's `navigator.credentials.get()` is no longer refused when the
  focus is not in its frame, as in Chrome, which checks focus for
  `create()` only. STomp's authenticator refused such a request at once
  with `NotAllowedError`, so a conditional request, or one that waits for
  the user, ended in milliseconds instead of waiting for the user or the
  page's signal whenever the host's own passkey sheet still held the focus
  (the passkeys suite's `conditionalAllowAborted` and `getAbort` checks
  failed now and then). (passkeys suite.)
