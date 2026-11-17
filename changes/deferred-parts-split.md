### Performance

- A frame that needs one of the deferred parts (its first XMLHttpRequest,
  `document.write`, WebSocket, `location.ancestorOrigins`, a message across
  the site pool's slots, and the like) evaluates only that part's group
  instead of every part: about 35 KB less heap for each such frame (an
  ad frame's first request, 20 frames on Chrome 157: 1,168 to 1,133 KB a
  frame). The parts' statement is a switch with a case for each group
  (build.js partsStatement), which a renderer compiles once. frame-cost
  gains a check of such frames.
