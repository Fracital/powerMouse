### Performance

- The about:blank frames a page writes its ads into (frames with no src,
  which run the page's own bundle) read `document.cookie` and
  `localStorage` from the copy the page holds, kept for every document of
  the bundle that reads the same jar or store: each frame's first reads,
  and its reads after any change, were synchronous round trips of its own
  on the page's thread. Eight frames' first reads of both took sixteen
  round trips and take none (blank-frame-reads suite, compared with native
  Chrome).
