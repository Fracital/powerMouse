### Fixes

- Firefox: a blob: worker that a page starts under a Content-Security-Policy
  (as Cloudflare Turnstile's challenge does) no longer throws
  `SecurityPolicyViolationEvent is not defined` as it starts. Firefox's
  workers have no such event, so the inject has no violation of theirs to
  hide.
