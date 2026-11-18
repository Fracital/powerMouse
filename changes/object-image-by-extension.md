### Fidelity

- An `<object>` or `<embed>` with no `type` whose URL names an image by
  its extension (`.png`, `.jpg`, ...) shows the image as natively, at
  the image's size and with no document, where it showed the image in a
  document of 300x150; an embed of such a URL that is no image fires
  error as natively (object-documents). Under a page policy that refuses
  data: for object-src it stays as before.

### Known limitations

- An `<object>` with no `type` whose URL names an image by its extension
  is boxed as a document, 300x150, while its copy is on its way (it has
  no URL then), where natively it is the image, 0x0 until the image is
  in; once the image is in it is the image's size (object-documents).
