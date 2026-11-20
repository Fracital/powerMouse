### Known limitations

- Withdrawn: the item further down this section that says a proxied YouTube
  video can stop at about 45 seconds. The stop was the measuring harness:
  Chrome driven over the DevTools protocol reads `navigator.webdriver` as
  true, and YouTube refuses that session with no proxy in the path.
  Measured again 2026-11-19 with headless Chrome 157, a fresh profile per
  load: with `--disable-blink-features=AutomationControlled`, 2 of 2 native
  loads and 2 of 2 through stomp.fracit.al (master 08fc18c7) played past
  99 s; Chrome as the DevTools protocol leaves it, natively, was refused 2
  of 2 and stopped at 41.9 and 45.0 s. docs/http3.md ("YouTube's
  attestation") has the larger table. Drop the old item when this release's
  notes are cut.
