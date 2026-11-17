### Security

- A page that replaces String or Array methods (`String.prototype.toLowerCase`,
  `Array.prototype.includes`, `push`, `slice`, ...) no longer has them called
  by the inject, nor sees them steer what it does. With `toLowerCase`
  answering `'text/plain'`, the hooks took the scripts of markup inserted
  with `runScripts` for data blocks and 9 of the hostile frame's 24 did not
  run, and the hooked `setAttribute` wrote nothing while a MutationObserver
  was live; with `Array.prototype.includes` answering `false`, or a dozen of
  either prototype's methods answering what they never would, the page read
  its real (routed) location through `location`, `eval` and destructuring.
  Every `value.method(...)` call of those methods in the inject bundles, their
  deferred parts and the WebRTC library is handed at build time to a helper
  (`scripts/ownMethods.mjs`, in the same onLoad as `ownIteration`) that calls
  the native taken before any page script ran when the receiver is a string
  or an array (an array of another realm keeps its own `map`, `filter`,
  `slice`, `splice`, `concat`, `flat` and `flatMap`), and anything else as
  written. (access-tamper `includes`, `stringMethods`, `arrayMethods`;
  adversarial-scripts' hostile `toLowerCase` frame no longer listed open.)
