### Fixes

- A worker's Content-Security-Policy report-uri gets its reports, as
  Chrome sends them: one `application/csp-report` POST a violation, with
  Sec-Fetch-Dest: report and the worker's URL as its Referer. The site
  never got one through the proxy.

### Fidelity

- A worker's violation names the place of the code that made the request
  (its sourceFile, lineNumber and columnNumber), as natively: it read the
  worker's script at line 0.
