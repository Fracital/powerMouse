### Security

- A sandboxed frame can no longer navigate or post as another document of
  its origin. Every document of an origin shares one stand-in for a window
  of another origin, and the stand-in navigated and posted as the document
  that had read it last. A sandboxed frame (allow-scripts allow-same-origin,
  no allow-top-navigation) that kept `top` in a variable navigated the top
  as soon as its unsandboxed parent read `top` again, or as soon as the demo
  host walked the frames' parents, and its messages reached the top with
  the parent as their source. When the parent had set document.domain, so
  that the frame no longer reached it, natively the frame could do neither
  in any way. The page's reads of a stand-in's `location` and
  `postMessage`, and its writes of `location`, now get members of the
  calling document's own, which act as that document. Code that reaches a
  stand-in's members past those reads (Reflect.get) acts as the first
  document that took the stand-in and still has the origin or domain it
  was made for. A document that set document.domain no longer shares the
  stand-ins it took before.
- A frame no longer reaches a window through a stand-in made by a document
  that reaches more than it does. A stand-in hands out the windows it
  reaches (`top.name`, `top.parent`) as the document that made it reached
  them, and a parent that read `top` and then set document.domain handed
  its frame (sandboxed or not) the raw window of a frame of another origin
  that it now reached itself: the frame read that frame's document,
  globals and location, where Chrome throws SecurityError.
- A page that put setters on Object.prototype was handed the inject's own
  module, and through it its client, when it next read a window of another
  origin: the record of which document a shared stand-in acted for was
  written into an ordinary object of the page's realm. That record has no
  prototype now.
  (stand-in-acting suite: sandboxed and unsandboxed frames of
  www.stomp-a.co.uk under a top of stomp-b.co.uk, natively and in both
  modes.)
