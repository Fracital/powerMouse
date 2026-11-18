### Performance

- A proxied document's shell asks for the document bundle by the hash of
  its bytes (`injectDocument.js?<hash>`), the demo server lets browsers
  keep it for good under that hash, and the service worker keeps the file
  it checked against the hash. No top or frame waits for a revalidation of
  the bundle with the host before its first script any more (a 304 of
  about 44 ms over a 40 ms link): the first script ran 41 to 44 ms sooner,
  first and second documents alike. A frame's or a written document's
  shell names the file its parent's realm was loaded from, so a page open
  through an update keeps one build's bundle in all its documents.
  (document-bundle-cache.)
