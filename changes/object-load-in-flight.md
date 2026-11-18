### Fidelity

- An `<object>` or `<embed>` whose document is still on its way behaves
  as natively: one with a `type` fired `load` twice (first for an empty
  document of its type), where Chrome fires it once, and an object's
  `contentDocument` and `contentWindow` were null until the document
  came, where Chrome shows its initial about:blank (object-documents,
  deferred-refusals).
