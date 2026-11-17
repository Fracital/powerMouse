### Fidelity

- A credentialless frame (`<iframe credentialless>`) and every frame under
  it is in a partition of its own, keyed by a nonce of its top-level
  document, as in Chrome: the credentialless frames under one top-level
  document share it, a new top-level document starts an empty one, and it
  shares no localStorage, sessionStorage, IndexedDB, Cache Storage, OPFS,
  locks, BroadcastChannel, workers, registrations or cookies with the
  site's other contexts. Its requests carry none of the site's cookies,
  what it sets stays in the partition, its loads are not kept in the HTTP
  cache, `window.credentialless` reads true, `iframe.credentialless` reads
  the attribute, and its popups open without an opener. It used to read
  and send the site's cookies and stores. (credentialless suite.)
