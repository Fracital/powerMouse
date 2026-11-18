### Performance

- A frame that needs one of the deferred parts evaluates only the case of
  that part's group, cut out of the parts' statement, instead of making
  the whole statement's function: about 11 KB less heap for each such frame
  (a frame's first XMLHttpRequest, 20 frames on Chrome 157: 1,132 to 1,121
  KB a frame, which a plain frame costs too). A top still has the whole
  statement from its shell's script. frame-cost's ceiling for such frames
  comes down from 1,144 to 1,130 KB.
