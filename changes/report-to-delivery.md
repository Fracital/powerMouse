### Fixes

- A document's Content-Security-Policy report-to endpoint gets its
  reports, as Chrome's Reporting API sends them: the endpoint its
  Reporting-Endpoints names gets `application/reports+json` uploads from
  the service worker, the first report at once and the rest batched about
  a minute later (or at once when their document is gone), with Chrome's
  preflight for another origin and cookies for the document's own. The
  site never got one through the proxy.
