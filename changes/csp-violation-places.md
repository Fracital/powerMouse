### Fixes

- A violation of an inline script of the page's markup says where its
  code was as Chrome's does: the document's URL (no query, no fragment)
  and the line and column where the script's text starts, in its event
  (sourceFile, lineNumber, columnNumber) and in its csp-violation report;
  an external one's report names none (null), as natively. The markup's
  scripts are reported in the order the parser prepares them, where one
  refused by a header policy was reported as the markup was copied, ahead
  of those before it.
- A report-only policy's refusal of a load that went out (an image, a
  fetch) reaches the page's ReportingObservers, one report however many
  events, as natively. A report-only script-src of nonces or hashes
  reports a page's external script it refuses, which went unreported (the
  worker judges only a list of hosts). (csp-meta-scripts; the Trusted
  Types reports are compared too, csp-trusted-types.)
