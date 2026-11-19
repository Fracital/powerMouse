### Fixes

- A document's Content-Security-Policy report-uri gets its reports, as
  Chrome sends them: one `application/csp-report` POST a violation (the
  browser's and the inject's), with Sec-Fetch-Dest: report and the cookies
  and Referer Chrome sends. The site never got one through the proxy.
- A violation the browser fires reads the document's referrer, not the
  proxy's page.
