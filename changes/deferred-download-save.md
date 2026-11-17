### Performance

- A same-origin download's copy (fetched through the proxy and saved from
  a `blob:` URL under the name the browser would pick) is a deferred part
  (`src/inject/dom/downloadSave.ts`), made at a document's first such
  download.
