### Build

- What runs the content blocker's procedural cosmetic filters in a page
  (the DOM it reads them with and the runner, `proceduralRunner` in
  `src/blocker/procedural.ts`) is part of the deferred part that compiles
  them, made with them; a document whose lists have none for its site
  makes neither.
