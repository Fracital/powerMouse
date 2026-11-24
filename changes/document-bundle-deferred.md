### Performance

- A frame loads less inject: the configured user-agent identity is a
  deferred part, made only when a userAgent is set, and a document's
  device-id maps and the hooks that show them are a deferred part too.
  dist/injectDocument.js is 462.5 KB, under its 466 KB budget (it had
  grown to 468.5 KB).
