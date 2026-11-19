### Build

- The routing of an SVG animation's values where it animates an href
  (`src/inject/dom/animatedHref.ts`: a `<set>` or `<animate>` whose
  attributeName is href by any prefix) is a deferred part of the document
  bundle, made at a document's first such animation; the hook and its check
  of the attributeName stay, so an animation of anything else never makes
  it. Without the part the animation's values are emptied: it animates the
  href to nothing, and the page reads them as it wrote them
  (deferred-refusals).
