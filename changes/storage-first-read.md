### Performance

- A document's first read of `localStorage` or `sessionStorage` takes the
  store's keys and every small value in one synchronous round trip; a key
  in neither is missing, a large value is read on its own. An ad library's
  first look at dozens of keys, most of them missing, was a round trip of
  its own for each (on apnews.com about 290 keys a load, 1.3 to 1.9 s of
  the page's thread). Sixty reads in a new frame now take two (storage-first-read
  suite, compared with native Chrome).
