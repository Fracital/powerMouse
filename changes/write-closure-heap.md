### Performance

- A proxied page keeps none of the markup STomp wrote it from once it is
  parsed. An Error a page script makes during the parse (Svelte's
  module-level ones) keeps the functions of its stack, and the one that
  writes the page's markup held the whole rewritten text, pinned by the
  pieces it was written in, and the map of the page's rewritten inline
  scripts: CNN kept 52 MB that way, natively such an Error holds only the
  page's own frames. The worker's table of the page's rewritten inline
  scripts and styles is let go at DOMContentLoaded (CNN's was 14 MB), and a
  large style the table answered is no longer kept a second time in the
  style memo (6 MB more there). A page with a 6 MB inline script and a kept
  Error held 49 MB more JS heap than native Chrome and holds about 1 MB
  (document-write-heap suite).
