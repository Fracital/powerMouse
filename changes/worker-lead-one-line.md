### Fixes

- An uncaught error in a proxied worker names the script's own line, as
  natively: the lead STomp puts before a worker script (its inject bundle
  and the client's start) took seven lines, so `ErrorEvent.lineno`, the
  worker's `onerror` and stacks read seven lines too far down (10 for line
  3). The lead is now on the script's first line (`src/scriptLead.ts`).
  (wpt-workers-basics, wpt-workers-scope.)
