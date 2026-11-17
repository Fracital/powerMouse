### Origin isolation

- With the site pool on, a click activates the frames Chrome activates.
  The frames of the clicked frame's origin below a frame of another slot
  (a frame of the page's own site inside another site's ad frame), and its
  ancestors past such a frame, read no activation: the input's walk of
  the page's frames compared each document's proxied top, which a
  document below a frame of another slot cannot reach.
