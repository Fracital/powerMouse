### Performance

- The stream that holds a `document.write()` call's unfinished markup and
  its tokenizer (`src/inject/dom/WriteStream.ts`, `writeTokenizer.ts`) are
  a deferred part, made at a document's first write. The tokenizer's list
  of raw text elements is a string, so nothing of it is a `Set` the page
  may have replaced by then (document-write compares such a page with
  Chrome). `injectDocument.js` is 4.5 KB smaller.
