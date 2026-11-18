### Fidelity

- A page's popup the host opens as a tab (`onOpen`) opens as Chrome's popup
  blocker lets it: only with a transient activation, and one for each.
  A script's `window.open()` or click on a target=_blank link with no
  activation (as a page loads, from a timer) opened a host tab where Chrome
  opens nothing and `window.open()` answers null; now it opens nothing.
  Opening one consumes the activation as natively: a second
  `window.open()` in the same click, a second link click, or the link of an
  inline handler that opened one and returned false opens nothing more, and
  `navigator.userActivation.isActive` reads false after it
  (`mayOpenPopup` in `src/inject/dom/activation.ts`, popup-activation, which
  runs Chrome with its popup blocker on).
