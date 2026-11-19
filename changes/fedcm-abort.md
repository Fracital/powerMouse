### Fidelity

- An abort of a FedCM request's signal ends it as in Chrome 157: the
  promise rejects with the signal's reason itself in a task of its own, the
  account chooser the host's page draws closes, no request reaches the
  provider after the abort, the tab may ask again at once, and the next
  request shows the chooser (an abort starts no cooldown). STomp used to
  read the signal only when the request was made, so an abort later left
  the request open and the chooser shown. (fedcm suite, natively and
  through the proxy.)
