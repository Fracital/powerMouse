### Fixes

- Passkeys work with the site pool on. Each slot's service worker is the
  authenticator of the sites that slot shows and keeps their keys in the
  host origin's one store, so a site's passkeys are the same whichever
  slot shows it. The
  hub's host asks the user about every ceremony, with the frame the
  document is in. A frame whose top is shown from another slot passes the
  focus check when the focus is in its frame of the host's page, as in
  Chrome. `controller.passkeys` lists, deletes and clears them all.
  Before, a slot's documents had no provider, and their
  registrations and sign-ins ended as the browser's decline. The passkeys
  suite now passes with the pool on, in both modes.
