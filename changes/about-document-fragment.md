### Fixes

- An about:srcdoc or about:blank document reads its fragment as written
  (`location.hash` is `#te%3Cst` after `location.hash = 'te<st'`), as
  natively, where it read the sealed form the proxy keeps in its address
  (`#~MoHm28GWsA`). Setting the fragment it is at already is no navigation,
  as natively, where it scrolled to the target again, and
  `location.hash = ''` in an about:srcdoc document clears its fragment,
  where the proxy compared with the parent's URL and did nothing.
  (wpt-location suite.)
