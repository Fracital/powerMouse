### Fidelity

- A page whose Trusted Types are enforced no longer has its own inline
  scripts reported as violations. The inject judged each script of the
  document's markup as text a sink had set: each was reported as a
  trusted-types-sink violation (22 on Google's sign-in page) and an inline
  module was refused, so it ran nothing. A script the parser makes runs as
  natively, with no report. (tt-parser-scripts suite.)
