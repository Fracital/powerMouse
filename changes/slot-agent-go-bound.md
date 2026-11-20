### Fixes

- A frame's go() to a site of a pool slot whose agent went away (its
  renderer crashed, or the host's page removed or navigated its frame)
  shows the site from the host's origin within about 4 s, where it waited
  for good when nothing else had asked the agent since: the viewport and
  geometry go() tells the agent first, and what the host changes for
  every worker, were asked without the bound the hub's other calls have,
  and a gone agent answers nothing (site-pool-fallback).
