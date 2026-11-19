### Fixes

- "Sign in with Google" through FedCM works through STomp. Chrome reads an
  identity provider's well-known file, config, accounts list and client
  metadata from its own process, with no CORS check, and Google sends no
  `Access-Control-Allow-Origin` for them; STomp's emulated flow read them
  with CORS, so on TikTok, Notion, CrazyGames and The Guardian the config
  fetch was "blocked by CORS policy" and the sign-in could never work. Those
  steps now go as Chrome 157's own requests do (measured): no-cors, with no
  Origin and no Referer, the well-known file and config without
  credentials and as from an opaque origin. The token and disconnect POSTs
  are still CORS requests of the relying party's origin, which the
  provider must allow. (fedcm suite, which now runs these flows natively
  too, against endpoints that send no CORS header.)
- A FedCM provider of another site than the page's is refused unless its
  well-known file lists the config (its one provider URL, or the config's
  accounts endpoint and login URL), and a config whose accounts, token or
  disconnect endpoint is of another origin, or that names no login URL, is
  refused, as Chrome refuses them. A token request that fails rejects with
  Chrome's `IdentityCredentialError` (`server_error` for a 500,
  `temporarily_unavailable` for a 503), where it was a generic
  `NetworkError`.
- What a provider tells the browser alone stays out of the page's reach.
  The service worker reads the no-cors steps' bodies and posts them on the
  document's load channel, so no Response or promise of the page's realm
  ever holds an account list (a page's getter of `Object.prototype.then` is
  handed every Response a fetch resolves with). The account chooser is drawn
  in a closed shadow root with the browser's own functions, its names and
  addresses shown as generated content, which `window.find()` does not see.
