### Fixes

- `location.ancestorOrigins` names an ancestor of an opaque origin (a frame
  sandboxed without `allow-same-origin`, a data: document) as `"null"`, as
  natively, where the proxy listed the origin of the ancestor's URL. It is
  the same object on every read until the ancestors change, as natively:
  the location of a frame removed after a read answers a new, empty list,
  where it kept the list it had made first. (wpt-location suite.)
