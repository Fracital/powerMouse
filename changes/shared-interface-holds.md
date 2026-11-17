### Performance

- A global interface held until the page first reads it (the canvas
  context interfaces, Geolocation) is held by one getter, one setter and
  one resolver bound to the name, instead of a wrapper pair and their
  closures of its own: about 1.5 KB less heap a frame.
