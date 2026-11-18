### Build

- The loading of an XML document through the XML shell (its parse, its
  prolog and the landing of its tree, `loadXML` in
  `src/inject/dom/instructions.ts`) is part of the deferred part of its
  processing instructions, made at the shell's call; without it the
  document does not load (deferred-refusals).
