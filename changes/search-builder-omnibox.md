### Demo and API

- `SearchBuilder` reads an address as Chrome's omnibox does. A scheme in
  any case is a scheme (`HTTPS://EXAMPLE.COM` was
  `http://HTTPS://EXAMPLE.COM`, now `https://example.com/`). Other schemes
  the omnibox navigates to pass through instead of getting `http://` in
  front (`ftp://x`, `view-source:`, `data:`, `about:`, `mailto:`), and
  `javascript:` or a scheme nothing handles is searched. A host without a
  scheme gets `https://`, the omnibox's default since Chrome 90, and
  `http://` for an IP address, `localhost`, a single label, a private
  top-level name or an address with a port, which Chrome does not upgrade.
  A space in a path is encoded (`example.com/a b` is
  `https://example.com/a%20b`). The omnibox module and the demo's address
  bars turn typed text into a URL through it, so they follow the same rules.
  search-builder covers 33 inputs.
