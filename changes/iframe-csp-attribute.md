### Fidelity

- A frame's `csp` attribute is enforced as Chrome's CSP Embedded
  Enforcement does: the frame's request says the policy
  (`Sec-Required-CSP`), and the document is refused unless its
  `Allow-CSP-From` names the parent's origin or `*` (the policy is then
  applied to it) or a policy of its own is at least as strict. The
  attribute was dropped, so the frame loaded unconstrained, and `iframe.csp`
  read back empty after `setAttribute`. (iframe-attributes suite.)
