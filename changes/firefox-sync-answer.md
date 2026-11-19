### Fixes

- What a page asks for synchronously answers in Firefox at once. A
  synchronous XMLHttpRequest took 30 s and came back with status 0 (17 ms
  natively), a localStorage read or write 10 s, and each classic script of
  a frame no service worker controls 5 s. The synchronous bridge waits on
  cookies the service worker sets, and Firefox shows a page that spins no
  cookie set after the spin began, and holds the worker's look at that page
  until the spin ends: every answer arrived only once the page had given
  up. A document in Firefox now also asks for the answer with a synchronous
  request of its own, which Firefox's worker answers while the page waits.
  An about:srcdoc frame under the proxy's sandboxed frame has no service
  worker in Firefox, as natively, so its scripts still go through the
  bridge, now in a few hundred ms each. Chrome and WebKit send that request
  past the worker; the first document to find so tells the worker, and the
  documents after it do not ask. (sync-engines.)
