### Build

- The checks of a page's own Content-Security-Policy against its code and
  the frames and objects it loads (`src/inject/dom/policyChecks.ts`, with the
  script and style source judging in `src/cspJudge.ts` and the SHA digests
  of `src/sha.ts`) are a deferred part of the document bundle, made at the
  first check a document with a policy of the page's makes; a data: URL's
  integrity check (`src/sriDigest.ts`) shares the part. Without the part a
  check refuses: code is not run or applied, an eval throws, a load goes to
  a refusal URL (deferred-refusals).
