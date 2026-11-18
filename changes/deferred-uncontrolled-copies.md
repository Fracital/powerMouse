### Build

- The copies a document no service worker controls makes of its loads (an
  about:blank frame or popup the page built, a document it opened, a blob:
  document: `src/inject/dom/uncontrolledCopies.ts`) are a deferred part of
  the document bundle, made at the first load such a document copies; a
  controlled document never makes it. Without the part a load keeps its
  routed value, which fails as a failed copy does, and a style's or a
  sheet's loads are not copied (deferred-refusals). The document bundle
  is 7.5 KB smaller.
