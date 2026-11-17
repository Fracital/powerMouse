### Build

- The console text of a mixed content notice
  (`src/mixedContentNotices.ts`) is a deferred part of the document bundle,
  made at a document's first notice; the worker bundle keeps it
  (`src/inject/mixedContentParts.ts`). Verdicts, blocks and upgrades are
  unchanged; without the part the notice is not printed. The document
  bundle is 1.3 KB smaller.
