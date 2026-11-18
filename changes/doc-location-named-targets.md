### Security

- A write of another proxied window's document location
  (`frame.contentDocument.location = url`, `doc['location'] = url`,
  `Reflect.set(doc, 'location', url)`, `Object.assign(doc, { location })`
  and the descriptor's setter called on the document) no longer leaves the
  proxy. Written raw into the browser's Location, the navigation of a frame
  or popup went to the site itself, with the proxy's address for its
  Referer, and a sibling frame's was refused. It is now this document's
  navigation of that window, as `w.location = url` is. (adversarial-navigation
  and nested-frames suites.)
- A write of a part of the location (`host`, `pathname` and the others) of
  a window whose document has committed but whose bundle has not run yet
  is made by the proxy, where it was written on the window's route.

### Fidelity

- `with (doc) location = url` on another window's document, and a
  `location` destructured from a popup's document, navigate as natively:
  the first was refused in a sibling frame, the second was made as the
  popup's own navigation, its referrer the popup's.
- The location of a window whose document has committed but whose bundle
  has not run yet reads as that document's URL (`href`, `origin`, the
  parts and `toString()`), as natively, where it read the proxy's route.
- A link, a GET form and `window.open(url, name)` aimed by name at a
  sibling frame navigate that frame, with the document that aimed for its
  initiator, as natively: the host frames the proxied top sandboxed, so
  the browser navigated no sibling frame for a frame (a form opened a new
  window instead, a link and `open()` a host tab). A link and
  `window.open(url, name)` aimed by name at a popup the tab opened navigate
  that popup, where they went to the host as a new tab, with no referrer.

### Known limitations

- A document whose bundle has not run yet answers its own URL getters
  (`document.URL` and its kin) with the proxy's route.
- A POST form aimed by name at a sibling frame opens a new window, as
  before: the copy of it the frame would submit is disconnected before it
  submits.
- A user's click on a link, or submission of a GET form, aimed by name at
  a sibling frame sends no Sec-Fetch-User: the navigation is made by
  script.
