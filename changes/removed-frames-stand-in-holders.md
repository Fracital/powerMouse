### Fixes

- A frame the page removes no longer stays in memory with its whole realm
  in two cases. A frame of another site that read its parent or its top
  took the stand-in the parent's window keeps for every document of the
  frame's origin, and the list of the documents that took it, a WeakRef to
  the stand-in and the entry itself were made by the frame's own realm,
  which kept that realm for the page's life (in Chrome and Firefox alike);
  the window that keeps them makes them now, and drops the holders of
  documents that are gone. And with dialing on (the demo's default), the
  host of a called frame listened on the port to the frame's document with
  a function made inside an async function, whose every variable
  SpiderMonkey keeps, the frame's window among them, and Firefox keeps a
  port that has a listener while it is entangled: in Firefox every called
  frame a page removed stayed. That listener is made outside it now, and a
  frame the page sets a src on before it inserts it (as Turnstile does) no
  longer leaves its record among the frames waiting to be placed. A
  Cloudflare Turnstile widget whose challenge kept failing replaced its
  challenge frame about once a second. Measured in Firefox 153.7.0esr on a
  local page that replaces a frame of another site (which messages its
  parent) about once a second: after three minutes of dialing the stomp
  origin's process held 474 MB of detached windows (747 MB in all), now
  none (123 MB); the classic way, 107 removed windows (335 MB) after two
  minutes, now none. Chrome kept about 1.1 MB per such frame, now 1.3 KB
  (frame-churn).
