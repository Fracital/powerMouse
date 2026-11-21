### Demo and API

- offline.html opened from file: no longer has the browser refuse
  `file:///stomp/transportWorker.js` (Firefox said "Security Error:
  Content at file:///... may not load data from
  file:///stomp/transportWorker.js"; Chrome refused it without a word).
  The transport runs in the page there, but the controller's clock still
  starts from that script, and the file carried no copy of it, so the
  clock fell back to the page's own timer. The file now carries it, and
  the clock runs in its worker. test:firefox now runs the file from file:
  with every file: load it leaves to the browser recorded, and fails on
  one or on a Security Error; its classic checks run on a classic server
  (STOMP_DIALING=0), as test/run.mjs runs them.
