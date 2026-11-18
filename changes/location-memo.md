### Performance

- A read of `location.href`, one of its parts or `document.URL` decodes
  the page's address only when the browser's address (or the name its
  shell gave the document) changed since the last read, and a part's
  getter parses the address once for every read of it: 20,000 reads of
  `location.href` went from about 143 to 16 ms (5 ms natively) and of
  `document.URL` from 97 to 6 ms (0.4 natively), measure-hooks on
  Chrome 157.
