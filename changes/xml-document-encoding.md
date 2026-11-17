### Fidelity

- An XML document (text/xml, application/xml, an +xml type, XHTML) keeps
  its encoding through the proxy. The worker served every XML shell as
  UTF-8, so `document.characterSet` read UTF-8 where Chrome reads what a
  byte order mark, the Content-Type charset or the XML declaration names
  (UTF-16LE for a UTF-32LE byte order mark, as web-platform-tests
  encoding/utf-32.html checks), and it decoded the document by HTML's
  rules, so a `<meta charset>` in an XHTML page changed its text where
  Chrome reads none in XML. (xml-encoding suite; wpt-encoding-legacy now
  runs in CI.)
