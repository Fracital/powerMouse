### Fidelity

- A CSS url() that is only a fragment (`fill: url(#gradient)`, a clip-path,
  mask, filter or marker by id) names an element of the document itself
  again, as natively: the rewriter routed it as an image of the page's URL,
  so SVG shapes painted with a gradient, clip or filter of the page drew
  their fallback or nothing, the browser fetched the page again as an
  image, a page whose img-src does not allow its own origin saw a
  securitypolicyviolation natively absent (Reddit's challenge page, whose
  logo is painted that way), and getComputedStyle answered an absolute
  URL. Such a url() is left as written, and the CSSOM readback no longer
  takes its `#` for the rewriter's kept token. (css-local-urls suite.)
