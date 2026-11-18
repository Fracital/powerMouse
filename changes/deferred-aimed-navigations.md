### Build

- A link or a form aimed at another window (its target `_top`, `_parent`,
  `_unfencedtop` or a name: the proxied parent or top, a window of another
  slot, a window by a name the browser would not navigate for the frame, a
  frame still on its initial about:blank) is navigated by a deferred part
  of the document bundle (`src/inject/dom/siteAcross.ts`), made at a
  document's first such click or submission. Without the part the link or
  the submit event navigates nothing and `submit()` throws
  (deferred-refusals).
