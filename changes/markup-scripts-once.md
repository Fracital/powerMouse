### Performance

- Each inline script of a page's markup (and of markup the page writes) is
  rewritten once, where it was rewritten twice: the copy that is serialized
  for the write went through the insertion hooks, which rewrote its scripts
  as a script the page inserts (no preamble), and the copy's own pass then
  rewrote them again from their text as markup's. The insertion hooks now
  leave the scripts of such a copy to that pass. And the worker's table of
  a document's inline scripts carries each text's key, which it had, so the
  page no longer hashes the text to put its holder statement back: YouTube's
  780 KB inline script was hashed and copied twice in the page, about 14 ms
  of its main thread before the first paint, now about 2 ms.
