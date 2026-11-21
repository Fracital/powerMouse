### Performance

- A reload of the demo revalidates the transport worker again no more: a
  profile's script URL (src/profile.ts) kept the query's other parts only
  through URLSearchParams, which wrote `transportWorker.js?<hash>` back as
  `?<hash>=`, a name the host does not keep for good, so every reload asked
  for the transport worker again before the transport could start
  (`reload-revalidations`). The other parts stay as they are written.
