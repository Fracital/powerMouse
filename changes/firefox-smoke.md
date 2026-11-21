### CI

- `npm run test:firefox` (test/firefox/smoke.mjs): the demo in a headless
  Firefox on a fresh profile, over WebDriver BiDi with a small client of
  our own, against a demo server and fixture of its own: boot, a fixture
  page proxied in both modes against its native load, real sites, Back,
  Forward and reload with the tokens, Stop, themes, the Extensions page,
  the Tor box, offline.html's Download and dialing. Not in CI; it skips
  where Firefox is missing.
