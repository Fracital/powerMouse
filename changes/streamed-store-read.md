### Performance

- A large document's head reads its localStorage without waiting for the
  service worker. Its first read of the store (every key and small value)
  went through the synchronous bridge, which spins until the worker
  answers. The head of a streamed document runs while the worker is still
  busy with the body, and on CNN that spin was 100 ms of `document.cookie`
  reads in the page. A streamed document now asks for that read with its
  markup, and its first piece waits for the answer (200 ms at most). The
  copy is on the stamp's list and its version is read before the worker
  reads the store. The answer is not taken if the stamp changed, or if
  this bundle wrote or saw a change meanwhile, so another document's write
  is still seen at once. (storage-first-read: a streamed head reads the
  value a document before it wrote, with no read through the bridge
  while the worker reads a 2.5 MB body, and then another frame's write.)
