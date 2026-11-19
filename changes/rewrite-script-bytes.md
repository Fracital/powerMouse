### Performance

- A script that comes as UTF-8 goes to the rewriter as its bytes and comes
  back as the bytes of its output, in a rewrite worker or the service
  worker, where it was decoded, sent to the worker and back as a string,
  and encoded again for the response. In Chrome 157 the twelve largest
  scripts of the site corpus (Discord's, Slack's, YouTube's, 3 to 12.7 MB)
  are rewritten in 39% less time end to end, and the service worker's own
  thread spends 105 ms on them where it spent 810. The output is the same
  bytes (`rewrite-bytes` suite).
