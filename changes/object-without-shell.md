### Fidelity

- An `<object>`'s or `<embed>`'s HTML or XML document whose shell could
  not be had (the deferred parts unavailable) fails as a failed fetch
  does: the object fires error and shows no document, with no further
  request, where its load went to the proxy origin's own server. A load
  that fails on an object already showing a document (one refused as
  mixed content) fires error too (deferred-refusals).
