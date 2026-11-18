### Fixes

- `document.all[i]` and the other computed reads, calls and optional
  chains of `document.all` evaluate as natively. The access helpers' test
  for null or undefined was minified to `== null`, which `document.all`
  meets, so a computed read of it threw an empty TypeError and an optional
  one was undefined. ThreatMetrix's script on chase.com walks
  `document.all[i]` and threw on every load. (document-all suite.)
