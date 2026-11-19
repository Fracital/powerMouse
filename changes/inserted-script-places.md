### Fixes

- A script the page's code gives a src its policy refuses is judged as it
  is inserted, as Chrome judges it: its violation names the inserting call
  (it named none), one never inserted fires nothing (it fired one when its
  src was set), and the page reads its src back meanwhile, so markup read
  back from it and written elsewhere carries it.
- A frame on about:blank keeps its parent's policy once the page opens it
  (document.open): a script written into it after that was let through.
