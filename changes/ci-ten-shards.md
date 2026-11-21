### CI

- The browser suites run as ten shards beside the adversarial job (six took
  25 to 33 minutes, ten take about 15), cut by `test/suite-seconds.json`
  refreshed from the CI machine's recent runs: it named a third fewer suites
  than there are, and the shards it cut ended up to 14 minutes apart.
  `node test/suite-seconds.mjs <job logs>` refreshes it, `LIST=1 npm test`
  prints the suites a run (or a `SHARD`) would run, and the shards build
  with `node build.js` and the offline page only, leaving the type check
  and the declarations to the check job.
