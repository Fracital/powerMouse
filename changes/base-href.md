### Performance

- The hooks read the base URL's text from what the document client keeps
  of it instead of parsing a copy each time: one URL parse less for
  nearly every URL a page writes or reads through a hooked attribute,
  property, fetch, XHR or navigation.
