### Build

- The table the document bundle hands its deferred parts names each value
  by its place among its file's exports, not by its export name (build.js
  `sharedKey`): 2 KB less in every frame's bundle and 5 KB less in the
  rewriter library's file.
