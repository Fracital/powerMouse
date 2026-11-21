### Fixes

- Back and Forward work in Firefox. The frame's history passes over an
  entry whose document navigated by script without a user activation, as
  Chrome's history intervention does, and read whether the document had
  one from the activation Chrome carries over to the next document of its
  origin; Firefox carries none, so every entry was passed over and Back
  was always off. A same-origin document that starts without one after a
  document that had one tells the controller the browser carries none,
  and from then on the document's own activation is read.
  (npm run test:firefox.)
