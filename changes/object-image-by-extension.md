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
  before decides, as natively (object-documents).
- An `<object>` of a `type` Chrome knows none of (whitespace alone or
  around an image's, such as `" "` or `" image/png"`, or an unknown one
  such as `application/x-foo`) fires error once and loads nothing, at a
  document's 300x150 box, as natively, where it showed the image (a
  `type` of whitespace) or fired error twice (object-documents).

### Known limitations

- The page's own style sheets see the held `type` of such an `<object>`
  while its copy is on its way (a `[type]` rule, `getComputedStyle`), and
  after it where the page wrote a `type` once the object was in the
  document, or its policy refuses data: for object-src.
