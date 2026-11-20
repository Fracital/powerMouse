### Performance

- A short image, font or text track (64 KB at most by its Content-Length)
  is read whole by the service worker as it comes, and the page, the HTTP
  cache, the memory cache and the document's repeat keep that one Blob.
  Each store used to read a branch of the body (a tee per store, every
  chunk through the worker once for each) and the memory cache copied
  what it read into a Blob of its own. A local page of 200 images of 8 KB,
  three loads: 2828 to 1558 ms of the worker's time and 1322 to 792 ms to
  load, Chrome 157. A body that breaks off still fails the image, as
  natively. (whole-bodies suite.)
