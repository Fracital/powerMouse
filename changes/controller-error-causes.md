### Fixes

- A host page whose Content-Security-Policy has no `'wasm-unsafe-eval'`
  may not compile the rewriter's wasm core module, and `wait()` said "the
  host does not serve the asset 'core'" though the host served it. The
  controller now tells Chrome's CompileError for the policy apart and says
  to add `'wasm-unsafe-eval'` to the policy's `script-src`.
- `StompController.register()` (and the constructor) on a page that is not
  a secure context, where the browser hides `navigator.serviceWorker`,
  said "Your browser does not support service workers." It now says that
  service workers need a secure context: HTTPS, or localhost while
  developing. controller-errors covers both.
