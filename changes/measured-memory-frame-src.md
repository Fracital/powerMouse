### Fidelity

- `performance.measureUserAgentSpecificMemory()` called in a proxied frame
  names the frame's own window with the `src` its element was given, as
  natively: the element is in the parent's document, which the result's
  mapping did not look in, so the frame's `src` read as the full URL it
  resolves to (a relative `src` came back absolute). The measured-memory
  suite compares the result with Chrome's in a cross-origin isolated page.
