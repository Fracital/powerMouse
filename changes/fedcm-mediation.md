### Fidelity

- A FedCM request through STomp picks, asks or refuses as Chrome 157's own
  does (measured in a regular profile). An `optional` or `silent` request
  with exactly one returning account (one whose `approved_clients` names the
  client, or one the user signed in with through STomp) signs in with no
  chooser; for ten minutes after such an automatic sign-in, and after
  `navigator.credentials.preventSilentAccess()`, an `optional` request shows
  the chooser and a `silent` one fails before any request, until the user
  picks an account. A `silent` request with no single returning account
  fails after reading the config and accounts, `required` always shows the
  chooser, and `conditional` rejects at once with Chrome's
  `NotSupportedError`. The chooser lists the accounts the user signed in
  with first, the latest first. A user's close of the chooser fails that
  request at once and every later request of the site, with no request, for
  Chrome's cooldown (two hours, then a day, a week, four weeks). STomp used
  to sign in silently with any account the provider marked approved, under
  every mode, and could never be made to show the chooser to a returning
  user. (fedcm suite, which runs every step natively in a persistent
  profile too.)
- The FedCM account chooser is drawn by the page that hosts STomp, over the
  proxied page's frame, so the proxied page's document, layout, hit testing
  and focus do not change while it is shown, as natively (fedcm suite).
- FedCM's client metadata is asked for only when an account in the list is
  new to the client, as Chrome does, with `?client_id=` in place of the
  endpoint's query and the relying party's `Origin`; its privacy policy and
  terms of service links show beside a new account. A token resolves three
  seconds after its request, and a request that fails before the chooser
  rejects after Chrome's random delay, as Chrome holds them.
- `navigator.credentials.preventSilentAccess()` resolves in a proxied top
  page and rejects with Chrome's `NotSupportedError` in a proxied frame, as
  natively; it rejected everywhere, as every proxied page is a frame to the
  browser.
