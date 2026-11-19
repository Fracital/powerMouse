### Performance

- A frame whose parent already set it up, as a page does when it reads a
  new frame's window before the frame loads, no longer runs the proxy's
  document bundle a second time only to throw the result away. The
  bundle's script now takes a median 0.2 ms of such a frame's start
  instead of 1.8 ms (Chrome 157, 60 ad-like frames). Every other document
  runs it as before.
