### Fidelity

- An extension's ISOLATED content scripts run in an isolated world of their
  own, as in Chrome: the page's DOM with the world's own globals,
  prototypes and builtins (docs/extensions.md, "Isolated worlds"). The
  page's changes to globals, prototypes and elements are not seen there,
  so Dark Reader's own sheets are no longer hidden from it on example.com
  by its MAIN script's `Document.prototype.styleSheets` override, and the
  page sees no frame, global or event of the world's. Markup and script
  URLs the world writes pass the page's Trusted Types: SponsorBlock's
  `innerHTML` writes on YouTube no longer throw, and Return YouTube
  Dislike's `script.src` is set. A content script's `import()` loads the
  extension's module in the world, so LanguageTool's content.js runs.
  The worker judges a module's web_accessible_resources by the origin of
  the document that asked, which it knows by the request's client, and
  refuses a request whose client it cannot name. Event details and
  message data reach the world as its own objects (extensions suite).

### Known limitations

- In an isolated world, top-level `let`, `const` and `class` are not
  shared between scripts, a script's `'use strict'` does not make it
  strict, code from `new Function` or an indirect `eval` sees the gone
  frame's `document` and `location`, and an element's id is not a global.
  A document whose policy forbids `eval` (a sandboxed frame without
  `allow-scripts`) runs its ISOLATED scripts in the page's realm, as
  before.
