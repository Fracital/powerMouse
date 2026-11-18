### Build

- The work of the rare markup sinks (execCommand's insertHTML, insertImage
  and createLink, Range's createContextualFragment, setHTMLUnsafe,
  setHTML, getHTML and XMLSerializer's serializeToString) and of the
  document.domain setter is a deferred part of the document bundle
  (`src/inject/dom/markupSinks.ts`), made at a page's first call of one;
  the hooks stay in place from the start. Without the part the call throws
  before the browser is asked (deferred-refusals). A command execCommand
  runs as it is, or one with no value, still needs no part.
