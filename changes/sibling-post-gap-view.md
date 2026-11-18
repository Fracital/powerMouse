### Fidelity

- A POST form aimed by name at a sibling frame navigates that frame, with
  its method, body, Origin and Referer as natively, where it opened a new
  window. The copy of the form the frame submits was not disconnected by
  anything of the frame's: submitted while the frame still showed the
  proxy's shell, it was taken out of the document, and its navigation
  aborted, by the `document.open()` that writes the page in. The
  submission now waits for the page to be written, and the document that
  submitted is its initiator.
- The navigate event of a sibling frame sent on by a link or a form of
  another frame shows that link, or the form's submitter, as its
  `sourceElement`, and a user's click or submission as `userInitiated`,
  as natively: it showed none (a link) or the form's copy (a POST) and
  `false`. The request's Sec-Fetch-User and the landed document's
  `navigation.activation` were already Chrome's.
- A document whose inject bundle has not run yet answers `URL`,
  `documentURI`, `baseURI`, `referrer` and `domain` with the page's
  values, as natively, where it answered with the proxy's route (another
  document reads it there: a popup's next document, or a frame's after
  one that had loaded).

### Known limitations

- A read of such a document before the parser has run the shell's first
  script, while the document is still empty, still gets the route
  (measured: 2 of 30 popups, by a page polling for them). It is no
  member the shell can answer for yet, and a hook of that realm's
  prototypes would be taken by its bundle for the browser's own.
