### Security

- A navigation another document of the page makes of a popup (through
  `w.location` or `w.document.location`, a `replace()`, `assign()` or
  `href` write, or a write of the location itself), between the commit of
  the popup's next document and the run of that document's bundle, no
  longer leaves the proxy. The window's own Location was handed over
  unwrapped, so the navigation went to the site itself, with the proxy's
  address for its Referer and `same-site` for its Sec-Fetch-Site (in every
  run). Such a window's Location is now gated as a proxied window's is, and
  its navigation is made by the proxy as the calling document's.
  (nested-frames suite.)

### Fidelity

- A navigation a frame starts in its parent's fresh frame, between the
  commit of that frame's document and the write of its markup, lands as
  natively, where it was aborted by the `document.open()` the write begins
  with (lost in 6 of 6 runs, now landing in every run). Such a navigation
  waits until the markup is written, bounded at 5 s. (nested-frames suite.)
