### Fixes

- A synchronous answer too large for the cookies it rides in (Chrome keeps
  180 of a site) is read in parts: the worker keeps the body and the page
  asks for it a part at a time. A script over about 400 KB written into a
  new frame's initial about:blank document (washingtonpost.com's ad frames
  write a 735 KB ad quality script) held the page's thread for the copy's
  whole 5 s limit and then never ran, and the cookies set for it pushed the
  proxy origin's own cookies out of the jar; a page's own synchronous
  XMLHttpRequest for such a body spun for 30 s and failed. Now the script
  runs in place, in order, after about 0.4 s, and the request reads the
  body byte for byte (sync-large-answer suite).
