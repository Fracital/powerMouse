### Docs

- docs/http3.md ("YouTube's attestation") has the 2026-11-19 measurements:
  a proxied YouTube video plays on as it does natively (0 of 40 proxied
  loads refused, over WebTransport, the WebSocket and HTTP/2 alike, through
  a demo on the machine and stomp.fracit.al; 0 of 27 native), and the
  video that stopped at about 45 seconds in headless probes was Chrome
  driven over the DevTools protocol, which reads `navigator.webdriver` as
  true and is refused natively too (8 of 8, native and proxied). AGENTS.md
  says to launch real-site probes with
  `--disable-blink-features=AutomationControlled`. The 2026-11-10 known
  limitation (refusals that followed the session's network path) no longer
  reproduces.
