### Fixes

- A long task no longer makes an XMLHttpRequest whose answer came in time
  fire its timeout. Chrome keeps the timeout in its network service, off
  the page's thread; STomp's timer was the thread's own, waited behind the
  same long task and ran ahead of the answer's tasks (a worker's request,
  delayed 100 ms with a 150 ms timeout, under a 200 ms loop timed out every
  time). The service worker now keeps the request's timeout on its own
  clock and answers the timeout itself, and a page timer that fires late
  leaves the verdict to it, so an answer already waiting is read first.
  (wpt-xhr-events xhr-timeout-longtask.)
