### Fixes

- An about:blank frame the parser makes after an external script is its
  parent's document, as natively: its origin was read through the
  page-facing `parent`, which asked for the frame's own origin, so it came
  out as an opaque origin's, its parent's `contentDocument` read null and it
  read no cookie (WPT cookies/navigated-away.html). (blank-frames suite,
  natively against both modes; wpt-cookies.)
