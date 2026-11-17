### Fixes

- `navigator.credentials.get({ password })` or `({ federated })` and
  `navigator.credentials.store()` of a PasswordCredential or a
  FederatedCredential answer as natively: a proxied top finds none (null)
  and keeps nothing, as a site with nothing saved, a frame of another site
  than one of its ancestors gets Chrome's NotAllowedError, and a frame of
  its ancestors' origin gets Chrome's NotSupportedError ("Error connecting to
  Credential Management service."). They reached the browser's own store,
  which keeps every proxied site's under the proxy's origin, and a proxied
  top got the error Chrome gives a frame. (credentials-password,
  adversarial-local suites.)
