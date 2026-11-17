### Fidelity

- `document.write()` from a module script, or an async or deferred one,
  once the document has loaded writes nothing again, as in Chrome (which
  warns in the console). The write hook opened the document itself first,
  which the browser does not refuse, so the module's markup replaced the
  page.
