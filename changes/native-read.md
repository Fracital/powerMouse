### Performance

- A read of `style`, `rel`, `as`, `integrity`, `httpEquiv`, `sandbox` or a
  form's `method`, which the hooks watch only for their setters, no longer
  swaps the element's prototype around the native getter: 20,000 writes
  of `el.style.width` (each a read of `style`) went from about 44 to 31 ms
  (2.7 natively), measure-hooks on Chrome 157.
