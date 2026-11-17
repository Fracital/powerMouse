### Dependencies

- `srcset` is no longer a dependency. A `srcset` attribute is read and
  written by `src/srcset.ts`, a copy of srcset 5.0.3's default (non-strict)
  parse and stringify (MIT License), with the same answers; the strict
  mode's validators the package kept in every frame are gone. The document
  bundle is 1.8 KB smaller.
