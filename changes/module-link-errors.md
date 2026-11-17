### Fidelity

- A module that fails to link (a name its module does not export, a JSON
  module's named binding, conflicting star exports) reports an error whose own
  message names the module by the page's URL, as the error event's message
  already did: `event.error.message` named the route. A route the browser
  quotes as a path is read back as well. The browser names the module by the
  specifier the page wrote ("./a.js"); through STomp it is the URL that
  specifier stands for (module-errors).
