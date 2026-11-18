### Build

- What an array method called with a window as its receiver, or a window
  handed as a list of arguments, reads of the window
  (`src/inject/windowArrays.ts`) is a deferred part of the document
  bundle, made at a document's first such call; the hooks on `call`,
  `apply`, `bind`, `Reflect.apply`, `concat` and the typed arrays' `from`
  stay, and the worker bundle, whose scope has no windows, has none of
  it. Without the part such a call throws before the browser's method is
  called (deferred-refusals).
