### Build

- The un-routing of the reports a page reads through ReportingObserver
  (`src/inject/reportsSeen.ts`) is a deferred part of the document bundle,
  made when the first report reaches the page; the worker bundle keeps it.
  Without the part the observer's callback gets no reports and
  `takeRecords()` throws.
