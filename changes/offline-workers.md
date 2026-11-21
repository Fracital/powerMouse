### Fixes

- offline.html's sites start workers in Chrome. A classic worker of a
  page's script or of a blob: URL starts from a prelude of the page's,
  which imports copies of the scripts its bootstrap names and sends the
  worker's routed requests to the worker the page runs. A worker's fetch,
  its messages and its location work as on the served demo. A module
  worker, and an importScripts() of a script the bootstrap does not
  name, still fail there, because nothing on file: can answer them.
