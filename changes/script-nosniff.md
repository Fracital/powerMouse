### Fixes

- A script whose response says `X-Content-Type-Options: nosniff` and has no
  JavaScript type is refused through STomp as it is natively: the script
  routes kept the type but dropped the header, so such a worker started
  instead of firing `error` (`src/server/rewrites.ts`). (wpt-workers-basics.)
