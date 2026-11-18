### Fidelity

- An `<object>` or `<embed>` with no `type` whose URL names an image by
  its extension (`.png`, `.jpg`, ...) shows the image as natively, at
  the image's size and with no document, where it showed the image in a
  document of 300x150; an embed of such a URL that is no image fires
  error as natively (object-documents). Under a page policy that refuses
  data: for object-src it stays as before.
- Such an `<object>` is the image while its copy is on its way too, made
  by a script or by the parser: 0x0, no document and no event, where it
  was a document's 300x150 box. It is held with a `type` of an image the
  page never sees: not in `getAttribute`, `getAttributeNames`,
  `attributes`, the `type` property, its markup, a copy of it, selectors
  or its observers' records. A `type` the page writes once the object is
  in the document with its URL changes nothing, as natively; one written
  before decides, as natively. Once its copy is in, the page's style
  sheets see the `type` the page wrote, as natively, under a policy that
  refuses data: too (object-documents, csp-fetch).
- An `<object>` of a `type` Chrome knows none of (whitespace alone or
  around an image's, such as `" "` or `" image/png"`, or an unknown one
  such as `application/x-foo`) fires error once and loads nothing, at a
  document's 300x150 box, as natively, where it showed the image (a
  `type` of whitespace) or fired error twice (object-documents).

### Known limitations

- The page's own style sheets (a `[type]` rule, `getComputedStyle`) and
  XPath (`document.evaluate` of `@type`) see the held `type` of such an
  `<object>` while its copy is on its way; once it is in, the page's
  `type` is the real one, a `type` it wrote meanwhile included. Rewriting
  the page's selectors and their readback, or its XPath expressions, would
  cost kilobytes for a window of milliseconds; XPath sees the markers of
  every hooked attribute the same way.
- A `type` the page writes once an `<object>` of a `type` of its own is
  in the document with its URL stays in its marker: Chrome went by the
  real one, and changing it with the copy's URL would count (a `" "`
  written over with `image/png` showed nothing, natively error). The
  page's style sheets and XPath see the earlier one (object-documents
  measures it).
- An `<object>` moved (removed and put back) while its copy is on its way
  keeps its hold: natively Chrome decides again by its `type` then, and a
  `type` written meanwhile makes it a document that loads twice.
- A `type` written after a layout on an `<object>` given its URL in the
  document: natively it keeps the box of a document with no document in
  it (the image's `type` written over with `text/html`); a hold has no
  such state, and the proxy goes by the new `type`.
