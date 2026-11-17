### Fixes

- A redirect whose `Location` holds bytes past ASCII goes where Chrome takes
  it: each byte escaped as it is (`%E2%98%83`), where the worker parsed the
  header as text and encoded every byte as a character of its own
  (`%C3%A2%C2%98%C2%83`), a URL the site never meant.
  (wpt-fetch-credentials-redirect suite.)
