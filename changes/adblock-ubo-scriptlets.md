### Fixes

- The built-in blocker runs the lists' scriptlets and `$redirect` resources:
  its default resources were Brave's published `resources.json`, which
  holds only Brave's own 25 resources and none of uBlock Origin's, so no
  `+js()` rule of the default lists ran on any site and a `$redirect` rule
  blocked instead. The default is now uBlock Origin's scriptlets and
  redirect resources, `adblock-resources.json` in the directory (built from
  uBO 1.76.4 by `scripts/adblock-resources.mjs`, 473 KB, 104 KB with gzip),
  which the service worker reads from its own origin. On YouTube the lists'
  `set-constant`, `json-prune`, `json-prune-fetch-response`,
  `json-prune-xhr-response` and `trusted-replace-*-response` rules now
  remove `adPlacements`, `playerAds` and `adSlots` from
  `ytInitialPlayerResponse` and from the player's answers, so the pre-roll
  no longer plays. A host that does not serve the new file gets the
  blocker without scriptlets and one console line, not the blocker off.
  (adblock-youtube suite, against the page loaded natively with the
  engine's scriptlets.)
- uBlock Origin's scriptlets run with the `scriptletGlobals` they read, as
  uBO and Brave declare it: without it the first scriptlet of a page threw,
  and since the engine orders a page's scriptlets by a hash, a different
  rule was lost on each page (one of YouTube's three `set-constant` rules).
