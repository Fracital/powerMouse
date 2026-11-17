### Fidelity

- A navigation whose Content-Type says nothing the browser can use (none,
  empty, `unknown/unknown`, `application/unknown`, `*/*`, a type with no
  slash) is sniffed as Chrome sniffs it: a body whose first 512 bytes, past
  leading white space, open one of the tags of Chrome's sniff table is
  rewritten and served as an HTML document, where a page served as
  `unknown/unknown`, `application/unknown` or `*/*` was passed through and
  ran its scripts unrewritten once the browser sniffed it. A body that does
  not sniff is passed through, so an answer with no type that Chrome shows
  as text no longer gets the proxy's shell. An answer that says
  `X-Content-Type-Options: nosniff` is not sniffed, and the browser is told
  so, with a type it cannot parse shown as text as natively
  (`adversarial-parse-html`, mime-sniff).
