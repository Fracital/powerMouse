### Fixes

- Markup with an attribute name only the HTML parser makes (one that starts
  with `=`, as in an ad server's `=""data-google-av-itpl="19"`) lands as
  natively, the attribute kept: the page's own markup, innerHTML,
  insertAdjacentHTML, outerHTML, a contextual fragment, setHTMLUnsafe and
  document.write threw InvalidCharacterError from setAttribute through the
  proxy (a Guardian live blog's ad wrapper did, on every ad it showed), and
  a page served with such an element stopped at it. (markup-parity suite,
  parser-names page.)
