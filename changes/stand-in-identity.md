### Fixes

- nytimes no longer hangs its tab. DoubleVerify's tag, in the about:blank
  child of Google's sandboxed safe frame, climbs `t = t.parent` until it
  meets `top`, and through the proxy `parent.parent` was not `top`: a
  sandboxed document made stand-ins of its own for the windows of other
  origins, so the frame and its child held two for the nytimes page, and
  the renderer spun at 100% CPU on a SecurityError a pass (6 hangs in 7
  loads, none natively; none in 14 now). Every document of an origin now shares one
  stand-in per window whatever its sandbox, as natively one WindowProxy,
  and the stand-in navigates and posts as the document that reached it
  last. frame-walks compares a safe frame's about:blank and srcdoc
  children with Chrome in both modes: their climbs, `===`, `Object.is`,
  WeakMap keys, `frames[i]`, `opener`, and what a frame of their origin
  with no sandbox holds.
