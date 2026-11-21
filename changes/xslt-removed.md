### Fidelity

- An XML document whose xml-stylesheet PI names an XSLT is left as it is,
  with no request for the stylesheet, in a browser without XSLT (Chrome 158
  removed `XSLTProcessor` and XSLT processing instructions), as natively.
  The inject fetched the stylesheet through the proxy before it found no
  processor; where the browser has XSLT the transform runs as before.
  `xml-stylesheets` compares both.
