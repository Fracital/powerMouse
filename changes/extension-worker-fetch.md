### Fidelity

- An MV3 extension's service worker controls its own pages, as Chrome's
  does: their `navigator.serviceWorker` has it as the controller, messages
  go both ways with a `WindowClient` as the source, and its `fetch` handler
  answers the requests Chrome gives it (navigations to the extension's
  pages, a web page's frame of one too, and their loads; never a web page's
  own request for a web_accessible_resource), with `respondWith`, a
  network error, or the package when it does not answer. Its global has
  the `install`, `activate`, `fetch` and `message` handler attributes,
  their event classes and `clients`. Violentmonkey's popup shows its
  site's script search links (it asked the worker for `/get-data.js` and
  got a 404). The extensions suite's worker probe checks it against Chrome 157.
- An extension's page reads its `blob:` URLs as `blob:chrome-extension://`
  and a link's origin, protocol and host there as Chrome's, and what the
  runtime defines in the page reads as native by its source too.

### Fixes

- A service worker given as `./js/background.js` (SponsorBlock's) starts:
  its generated page was looked for at `./js/` and answered 404, so its
  content scripts' messages found no receiver.
