### Fixes

- Under a page's script-src, reading a handler's property (`el.onclick`)
  gave the function with no violation; Chrome compiles and judges it
  there, and reads null where it is refused. A handler's violation as it
  runs now names the code that dispatched its event, else the handler's
  place in the markup; a handler that runs before it was judged as parsed
  (an iframe's load) is no longer reported twice; one a document.write
  wrote is judged once the parser inserted it, at the write, as natively.
  (csp-meta-scripts)
- A javascript: URL is judged as its navigation starts by the policies of
  the document whose link, location or open() started it, at that code,
  as Chrome judges it: a link into a frame that the linking page's policy
  refuses no longer runs. One of statements keeps its `'use strict'` a
  directive and its `let` and `const` the window's. (csp-meta-scripts)
