### CI

- Three differential fuzz suites, `adversarial-parse-css`,
  `adversarial-parse-html` and `adversarial-parse-url`, load seeded
  generated cases natively and through the proxy in the same Chrome and fail
  on a request past the proxy, a proxy tell in a request, or a load or
  readback that differs from native; each lists its open findings with the
  reason (`test/parserFuzz.mjs`).
