### Build

- The sealed copies of an uncontrolled document's images
  (`src/inject/dom/sealedCopies.ts`) are part of the deferred part that
  makes the document's copies; the natives they use are still taken when
  the bundle loads (`src/inject/dom/sealerNatives.ts`).
