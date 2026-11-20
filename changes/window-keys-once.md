### Performance

- Every proxied page's setup reads the window's own keys once, where it
  read them six times: the canvas and geolocation interfaces it holds until
  first use each read all of them (about a thousand) to find the one key
  before their own. That was 0.5 ms of the main thread on every load, and
  is under 0.1 ms now.
- A restarted service worker reads the content blocker's stored engine and
  resources at the same time, and hands the resources (473 KB) to the
  engine as the bytes it stored, where it decoded them to text and encoded
  them again.
