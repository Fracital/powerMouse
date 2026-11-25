### Fixes

- The protected demo no longer installs the host VM's document wrappers in its
  proxied tabs and webviews. Parser-created nodes retain the page's own
  prototypes, so hydration (including the Cat API's images, picture sources
  and stylesheets) runs through the proxy's URL hooks.
- Dialed image and media documents show the resource instead of decoding its
  bytes as HTML. Text and JSON are inert text, with a pretty-print option for
  valid JSON. PDF answers are offered to the browser's viewer with a download
  link when the sandbox prevents the viewer from displaying them.
