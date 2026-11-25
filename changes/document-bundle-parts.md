### Performance

- dist/injectDocument.js, which every proxied document and frame loads and
  compiles, is 8,445 bytes smaller (477,125 to 468,680 bytes; its budget in
  the frame-cost suite stays 466 KB, and the bundle was 59 bytes under it).
  Code a document reaches only by a rare call is a deferred part made at
  its first use: the matching of URLs against the page's own CSP source
  lists, what document.startViewTransition() does in a frame, a page's
  import map (its integrity note and routing), the codec's wasm instance
  (made by a top from the parts its shell holds), a ReportingObserver's
  constructor and observe()/disconnect(), a form's submission, a link a
  click opens as a host tab or a sandboxed popup, a click on a link to a
  fragment of the document, navigator.credentials.get(), store() and
  preventSilentAccess(), a media session's artwork, a CSP violation's
  sample, a javascript: URL's document, navigation.navigate(),
  window.viewport.segments and the SecurityErrors of an opaque document.
  What a Worker's and a SharedWorker's construction does past the page's
  checks joined the part a construction already made. Where the parts
  cannot be had, each refuses: the import map is empty, the submission and
  the link open nothing (submit() throws), the credential calls reject,
  the view transition, the artwork, the observer and navigate() throw.
  dist/rewriterLib.js, which holds the parts, grew from 404,325 to 419,594
  bytes; dist/injectWorker.js grew 312 bytes (357,851 to 358,163).
