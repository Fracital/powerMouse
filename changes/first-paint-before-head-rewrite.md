### Performance

- A streamed document's first part is drawn sooner. The service worker
  rewrote the first piece of its markup (on CNN the whole 3.7 MB head) in
  the task that served the shell, and the page's request for its inject
  bundle waited for the worker to finish (190 ms): the rewrite now starts
  once the page asked for its bundle, or 40 ms after the shell. The page
  wrote the first of its body only after 250 ms where the head had been
  big, and its first parsing passes ran back to back, which kept Chrome
  from drawing them for about 100 ms: the body's first part is written at
  once, and the first two writes are drawn before the next pass (a frame,
  or 50 ms where none comes). First paint, cold, Chrome 157, a local page
  with a 3 MB head style: 767 ms to 587 ms (trickled in at 8 MB/s, 1169 to
  991); a 5 MB page trickled in with a 0.5 MB style and script in its
  head, 676 to 498. (html-stream suite: a frame that is not displayed
  loads whole.)
