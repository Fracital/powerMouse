### Fidelity

- A FedCM request made while another of the tab's is open (in flight, its
  chooser shown, its failure or token held) is refused as Chrome 157
  refuses it: `NotAllowedError` "Only one navigator.credentials.get request
  may be outstanding at one time.", in a task of its own, for a request of
  the same document, of a frame under the same proxied top, and in every
  mediation mode, while the first goes on. STomp used to run the second
  request too, with a chooser of its own. (fedcm suite, natively and
  through the proxy.)
