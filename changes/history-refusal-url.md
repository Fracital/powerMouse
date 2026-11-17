### Fidelity

- A cross-origin `history.pushState()` or `replaceState()` refusal quotes the
  URL resolved, as Chrome does, where it quoted the text the page gave: a
  protocol-relative or mixed-case URL as parsed (`http://other.example/A` for
  `HTTP://OTHER.EXAMPLE/A`), and one over 1024 characters elided to its first
  511, `...` and its last 510, as is the document's own URL. A URL that does
  not parse is still quoted as given. (error-surfaces suite:
  `pushStateProtocolRelative`, `pushStateMixedCase`, `pushStateLong`.)
