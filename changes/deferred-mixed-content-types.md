### Build

- Chrome's name for what a mixed content request loads (`typeName`) is in
  the text of a mixed content notice (`src/mixedContentNotices.ts`), a
  deferred part of the document bundle made at a document's first notice:
  a notice carries the request's destination where the request did not
  name its type, and only its text reads the name.
