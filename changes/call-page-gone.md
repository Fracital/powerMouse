### Fixes

- Dialing: a call page that goes while its call is out no longer leaves the
  tab waiting for the call's 45 s bound. The page says so when it goes, and
  while its call is out the host pings it every two seconds: one that
  answers nothing for ten seconds (a content slot whose process went) is
  taken for gone. Before it said it was ready the call is made elsewhere;
  after, the call fails then.
