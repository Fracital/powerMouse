### Build

- `navigator.login.setStatus()`'s body (its argument checks, Chrome's
  TypeErrors) is in the FedCM part of the document bundle
  (`src/inject/dom/credentialFlows.ts`), made at a document's first call;
  the stand-in and its hook stay. Without the part the call rejects
  (deferred-refusals).
