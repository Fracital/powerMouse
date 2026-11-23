### Fidelity

- Strict HTTPS in a site's shields now requires it, as Brave's does: the
  site's top-level page asked for over http is upgraded to https too, and
  when the https load fails at the connection or at TLS the tab shows a
  "Connection is not secure" interstitial instead of the http page. Nothing
  is sent to the site over http until "Continue to site" is picked, which
  loads the http page and leaves the site un-upgraded for the rest of the
  worker's life. Strict behaved exactly like "upgrade" before. "Upgrade"
  still leaves the top-level page as it was asked for, so a site with no
  https loads over http. The `shields-sites` suite covers both, in classic
  and dialed tabs.

### Security

- Every frame of a tab now follows the shields of the tab's top-level page,
  however deep and of whatever site, as Brave's do: a third-party frame two
  levels down had the shields of its own site, so a site whose shields were
  up could be got around by a frame of another site with shields down, and
  shields down at the top did not reach such a frame. Its navigation, its
  subresources (in a dialed tab too, whose frames' URLs name no route), its
  Block scripts policy, cosmetic filters and fingerprint surfaces, and its
  sockets are all keyed by the top. The `shields-sites` suite checks a frame
  two levels down under shields down and up, in classic and dialed tabs.
