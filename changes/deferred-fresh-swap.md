### Build

- A frame's fresh browsing context (`src/inject/dom/freshSwap.ts`: the swap
  of a frame element that is to show another origin's document, and the
  record of the window it showed) is a deferred part of the document
  bundle, made at a document's first such frame; the gates that ask for it
  and the reads of the record stay. Without the part the frame is not
  navigated: its src set leaves it without one, the worker's redirect
  document stays, and a navigation its own document began goes nowhere
  (deferred-refusals).
