### Fixes

- HTTP/3 no longer hands an informational response to the page as the final
  one. A 103 Early Hints head is consumed and the transport waits for the
  final head, so a page such as https://claude.ai/login no longer fails with
  `Response constructor: Invalid response status code`.
